/** Wire-compatible with GQ_Support_Signer. #32 owns the shared signing fixtures. */
const encoder = new TextEncoder();
export const sha256 = async (text: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
const base64 = (bytes: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode = (text: string, size: number): Uint8Array<ArrayBuffer> => {
  const bytes = Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  if (bytes.length !== size || base64(bytes.buffer) !== text) throw new Error("Invalid encoding");
  return bytes;
};

/** A signed-request wire format: its canonical label and the headers it signs. */
export interface SignatureScheme {
  readonly label: string;
  readonly keyId: string;
  /** The signed principal: an installation ID, or the asserted staff actor. */
  readonly principal: string;
  readonly timestamp: string;
  readonly requestId: string;
  readonly signature: string;
}
export const INSTALLATION_SIGNATURE: SignatureScheme = { label: "gq-support-v1", keyId: "GQ-Support-Key-Id",
  principal: "GQ-Support-Installation-Id", timestamp: "GQ-Support-Timestamp", requestId: "GQ-Support-Request-Id",
  signature: "GQ-Support-Signature" };
/** A staff dashboard's requests (src/operations-api.ts). Its own label, so no installation signature verifies here. */
export const OPERATIONS_SIGNATURE: SignatureScheme = { label: "gq-support-operations-v1", keyId: "GQ-Operations-Key-Id",
  principal: "GQ-Operations-Actor", timestamp: "GQ-Operations-Timestamp", requestId: "GQ-Operations-Request-Id",
  signature: "GQ-Operations-Signature" };

/** Verifies possession only. Authority and replay checks remain at the database boundary. */
export const verifySignature = async (request: Request, body: string, publicKey: string, now: number,
  scheme: SignatureScheme = INSTALLATION_SIGNATURE): Promise<boolean> => {
  try {
    const headers = request.headers;
    const timestamp = headers.get(scheme.timestamp) ?? "";
    const requestId = headers.get(scheme.requestId) ?? "";
    if (!/^\d{10}$/.test(timestamp) || Math.abs(now - Number(timestamp) * 1000) > 300_000 ||
      !/^[a-zA-Z0-9-]{16,128}$/.test(requestId)) return false;
    const digest = `sha-256=:${base64(await crypto.subtle.digest("SHA-256", encoder.encode(body)))}:`;
    if (headers.get("Content-Digest") !== digest) return false;
    const url = new URL(request.url);
    const canonical = [scheme.label, request.method.toUpperCase(), url.pathname + url.search,
      headers.get(scheme.keyId) ?? "", headers.get(scheme.principal) ?? "",
      timestamp, requestId, digest].join("\n");
    const key = await crypto.subtle.importKey("raw", decode(publicKey, 32), "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key,
      decode(headers.get(scheme.signature) ?? "", 64), encoder.encode(canonical));
  } catch {
    return false;
  }
};
