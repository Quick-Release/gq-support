import type { D1Database } from "@cloudflare/workers-types";
import { handleRequest } from "../src/installation-api.ts";
import { runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";

const encoder = new TextEncoder();
const base64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64");

export const keyPair = async (): Promise<CryptoKeyPair> => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("Expected an Ed25519 key pair");
  return pair;
};

export const publicKeyOf = async (pair: CryptoKeyPair) => base64(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);

// Independently spells the PHP signer's wire format, rather than importing the verifier.
export const signed = async (pair: CryptoKeyPair, method: string, path: string, body = "", keyId = "", installationId = "installation-a") => {
  const digest = `sha-256=:${base64(await crypto.subtle.digest("SHA-256", encoder.encode(body)))}:`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestId = crypto.randomUUID();
  const canonical = ["gq-support-v1", method, path, keyId, installationId, timestamp, requestId, digest].join("\n");
  const signature = await crypto.subtle.sign("Ed25519", pair.privateKey, encoder.encode(canonical));
  return new Request(`https://support.example${path}`, {
    method, body: body || undefined,
    headers: {
      "GQ-Support-Key-Id": keyId, "GQ-Support-Installation-Id": installationId,
      "GQ-Support-Timestamp": timestamp, "GQ-Support-Request-Id": requestId,
      "Content-Digest": digest, "GQ-Support-Signature": base64(signature),
      "CF-Connecting-IP": "192.0.2.1",
    },
  });
};

export interface Installation {
  readonly pair: CryptoKeyPair;
  readonly keyId: string;
  readonly installationId: string;
  /** Signs and sends one request as this installation. */
  send(method: string, path: string, body?: string, headers?: Record<string, string>): Promise<Response>;
}

/** An enrolled-installation harness over the public HTTP boundary and the operator CLI seam. */
export const harness = (db: D1Database, mappings: readonly RepositoryMapping[]) => {
  const send = (request: Request, config = mappings) => handleRequest(request, db, config);
  const operator = (command: string, slot: string, now?: number) => runOperator([command, slot], {
    query: async (sql, parameters) => (await db.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results,
    recordRevocation: async () => {}, mappings, now,
  });
  const enroll = async (slot: string, installationId: string): Promise<Installation> => {
    const pair = await keyPair();
    const body = JSON.stringify({ code: await operator("enroll", slot), installation_id: installationId,
      origin: "https://shop.example", public_key: await publicKeyOf(pair) });
    const response = await send(await signed(pair, "POST", "/v1/enroll", body, "", installationId));
    if (response.status !== 200) throw new Error(`Enrollment failed: ${response.status}`);
    const { key_id: keyId } = await response.json() as { key_id: string };
    return {
      pair, keyId, installationId,
      send: async (method, path, body = "", headers = {}) => {
        const request = await signed(pair, method, path, body, keyId, installationId);
        for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
        return send(request);
      },
    };
  };
  return { send, operator, enroll };
};
