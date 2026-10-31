import { keyPair, publicKeyOf } from "./installation-client.ts";

const encoder = new TextEncoder();
const base64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64");

/** A signed operations wire format: its canonical label and header prefix. */
export interface ClientScheme { readonly label: string; readonly prefix: string; readonly principal: string }
const OPERATIONS: ClientScheme = { label: "gq-support-operations-v1", prefix: "GQ-Operations", principal: "Actor" };
/** The independent checker's own identity (src/independent-check.ts), never a staff member's. */
export const CHECKER: ClientScheme = { label: "gq-support-checker-v1", prefix: "GQ-Checker", principal: "Run" };

/** A staff dashboard's signing key, such as Banquinha's, registered with the operations API. */
export interface OperationsClient {
  readonly keyId: string;
  readonly publicKey: string;
  readonly privateKey: CryptoKey;
  /** Signs one request as this client, asserting `actor` as the authenticated team member. */
  request(method: string, path: string, actor: string, body?: string, options?: { now?: number; requestId?: string }): Promise<Request>;
}

// Independently spells the operations wire format, rather than importing the verifier.
export const operationsClient = async (keyId = "banquinha-test", scheme = OPERATIONS): Promise<OperationsClient> => {
  const pair = await keyPair();
  const header = (name: string) => `${scheme.prefix}-${name}`;
  return {
    keyId, publicKey: await publicKeyOf(pair), privateKey: pair.privateKey,
    request: async (method, path, actor, body = "", { now = Date.now(), requestId = crypto.randomUUID() } = {}) => {
      const digest = `sha-256=:${base64(await crypto.subtle.digest("SHA-256", encoder.encode(body)))}:`;
      const timestamp = String(Math.floor(now / 1000));
      const canonical = [scheme.label, method, path, keyId, actor, timestamp, requestId, digest].join("\n");
      const signature = await crypto.subtle.sign("Ed25519", pair.privateKey, encoder.encode(canonical));
      return new Request(`https://support.example${path}`, {
        method, body: body || undefined,
        headers: {
          [header("Key-Id")]: keyId, [header(scheme.principal)]: actor,
          [header("Timestamp")]: timestamp, [header("Request-Id")]: requestId,
          "Content-Digest": digest, [header("Signature")]: base64(signature),
        },
      });
    },
  };
};
