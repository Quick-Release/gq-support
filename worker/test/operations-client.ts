import { keyPair, publicKeyOf } from "./installation-client.ts";

const encoder = new TextEncoder();
const base64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64");

/** A staff dashboard's signing key, such as Banquinha's, registered with the operations API. */
export interface OperationsClient {
  readonly keyId: string;
  readonly publicKey: string;
  /** Signs one request as this client, asserting `actor` as the authenticated team member. */
  request(method: string, path: string, actor: string, body?: string, options?: { now?: number; requestId?: string }): Promise<Request>;
}

// Independently spells the operations wire format, rather than importing the verifier.
export const operationsClient = async (keyId = "banquinha-test"): Promise<OperationsClient> => {
  const pair = await keyPair();
  return {
    keyId, publicKey: await publicKeyOf(pair),
    request: async (method, path, actor, body = "", { now = Date.now(), requestId = crypto.randomUUID() } = {}) => {
      const digest = `sha-256=:${base64(await crypto.subtle.digest("SHA-256", encoder.encode(body)))}:`;
      const timestamp = String(Math.floor(now / 1000));
      const canonical = ["gq-support-operations-v1", method, path, keyId, actor, timestamp, requestId, digest].join("\n");
      const signature = await crypto.subtle.sign("Ed25519", pair.privateKey, encoder.encode(canonical));
      return new Request(`https://support.example${path}`, {
        method, body: body || undefined,
        headers: {
          "GQ-Operations-Key-Id": keyId, "GQ-Operations-Actor": actor,
          "GQ-Operations-Timestamp": timestamp, "GQ-Operations-Request-Id": requestId,
          "Content-Digest": digest, "GQ-Operations-Signature": base64(signature),
        },
      });
    },
  };
};
