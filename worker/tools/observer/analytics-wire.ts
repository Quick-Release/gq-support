/** Selected GraphQL envelope from the query documented in the observer design.
 * This projection establishes NO account/stage/authentication/sampling provenance.
 * Other provider adapters (including GitHub) are deliberately not implemented.
 * Unknown provider fields are discarded by this explicit allowlist projection;
 * normalized protocol bodies are subsequently decoded with exact keys. */
export function projectAnalytics(body: Uint8Array, expectedWorker: string):
  { body: Uint8Array; coverage: "partial" | "unknown" } | null {
  if (body.byteLength > 65536 || !/^[a-zA-Z0-9_-]{1,63}$/.test(expectedWorker)) return null;
  try {
    const root = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
    const accounts = root?.data?.viewer?.accounts;
    if (!Array.isArray(accounts) || accounts.length !== 1) return null;
    const input = accounts[0]?.workersInvocationsAdaptive;
    if (!Array.isArray(input) || input.length > 100) return null;
    const rows = input.map(row => {
      const d = row?.dimensions, s = row?.sum;
      if (d?.scriptName !== expectedWorker || typeof d.datetime !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(d.datetime) ||
        typeof d.status !== "string" || d.status.length > 64 || !Number.isSafeInteger(s?.requests) ||
        !Number.isSafeInteger(s?.errors) || s.errors < 0 || s.requests < s.errors || s.requests > 999999) throw 0;
      const at = Date.parse(d.datetime);
      if (!Number.isSafeInteger(at) || at < 0 || new Date(at).toISOString() !== d.datetime.replace(/(?<=:\d{2})Z$/, ".000Z")) throw 0;
      return { at, requests: s.requests as number, errors: s.errors as number };
    });
    // No inferred completeness from HTTP 200 or absent errors; sampling/lag remain
    // unknown. Valid positive rows survive a simultaneous GraphQL error envelope.
    return { body: new TextEncoder().encode(JSON.stringify({ rows })), coverage: root.errors ? "partial" : "unknown" };
  } catch { return null; }
}
