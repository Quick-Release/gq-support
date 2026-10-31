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
  /** Headers whose values the signature also covers, after the principal: authenticated claims. */
  readonly claims?: readonly string[];
}
export const INSTALLATION_SIGNATURE: SignatureScheme = { label: "gq-support-v1", keyId: "GQ-Support-Key-Id",
  principal: "GQ-Support-Installation-Id", timestamp: "GQ-Support-Timestamp", requestId: "GQ-Support-Request-Id",
  signature: "GQ-Support-Signature" };
/**
 * The installation scheme that also signs the plugin's version (#141). Its own
 * label, so a v1 signature never verifies as v2, nor v2 as v1: the version header
 * can be neither added to a legacy request nor stripped from a signed one.
 */
export const INSTALLATION_SIGNATURE_V2: SignatureScheme = { ...INSTALLATION_SIGNATURE, label: "gq-support-v2",
  claims: ["GQ-Support-Plugin-Version"] };
/** A plugin version as WordPress reports it, bounded before it is signed or compared. */
export const PLUGIN_VERSION = /^[0-9][A-Za-z0-9.+_-]{0,63}$/;
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
      ...(scheme.claims ?? []).map((claim) => headers.get(claim) ?? ""), timestamp, requestId, digest].join("\n");
    const key = await crypto.subtle.importKey("raw", decode(publicKey, 32), "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key,
      decode(headers.get(scheme.signature) ?? "", 64), encoder.encode(canonical));
  } catch {
    return false;
  }
};
/** The independent checker's requests (src/independent-check.ts): its own label, so no staff or installation signature verifies here. */
export const CHECKER_SIGNATURE: SignatureScheme = { label: "gq-support-checker-v1", keyId: "GQ-Checker-Key-Id",
  principal: "GQ-Checker-Run", timestamp: "GQ-Checker-Timestamp", requestId: "GQ-Checker-Request-Id",
  signature: "GQ-Checker-Signature" };

/**
 * Verifies an installation's request under either scheme. Only a v2 signature
 * authenticates the plugin version; a legacy v1 request's version header, which
 * anyone could add, is ignored and its version is `null` (unknown).
 */
export const verifyInstallation = async (request: Request, body: string, publicKey: string, now: number):
  Promise<{ readonly pluginVersion: string | null } | null> => {
  const version = request.headers.get("GQ-Support-Plugin-Version");
  if (version !== null && PLUGIN_VERSION.test(version) && await verifySignature(request, body, publicKey, now, INSTALLATION_SIGNATURE_V2)) {
    return { pluginVersion: version };
  }
  return await verifySignature(request, body, publicKey, now) ? { pluginVersion: null } : null;
};
