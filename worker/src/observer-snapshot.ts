/** Fixed aggregate wire contract. No transport provenance or activation proof. */
export const observerOutcomes = ["not_run", "ok", "failed", "timed_out", "contained"] as const;
export const terminalOutcomes = ["settled", "failed", "interrupted"] as const;
export type ObserverTick = ["staging" | "prod", string, number, number, number, number, number | null,
  number | null, number, number, number, number, number];
export interface ObserverSnapshot {
  version: 1; generated: number; stage: "staging" | "prod"; candidate: string;
  generation: number; maintenance: "open" | "held" | "recorded" | "verified";
  watermark: number; partial: boolean; activation: null; coverage: "unknown";
  route: "disabled" | "ready" | "blocked_unknown" | "rate_limited";
  ticks: ObserverTick[];
}
const invalid = (): never => { throw new Error("observer_unavailable"); };
export function exact(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return invalid();
  const r = v as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k))) return invalid();
  return r;
}
export function finiteInt(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > max) return invalid();
  return v;
}
export function enumValue<const T extends readonly string[]>(v: unknown, choices: T): T[number] {
  if (typeof v !== "string" || !choices.includes(v)) return invalid();
  return v;
}
export function release(v: unknown): string {
  if (typeof v !== "string" || !/^[a-f0-9]{40}$/.test(v)) return invalid();
  return v;
}
export function decodeObserverSnapshot(value: unknown, at: number): ObserverSnapshot {
  const o = exact(value, ["version", "generated", "stage", "candidate", "generation", "maintenance", "watermark", "partial", "activation", "coverage", "route", "ticks"]);
  if (o.version !== 1 || o.activation !== null || o.coverage !== "unknown" || typeof o.partial !== "boolean") return invalid();
  const generated = finiteInt(o.generated, at), watermark = finiteInt(o.watermark, generated);
  if (watermark % 60_000 || !Array.isArray(o.ticks) || o.ticks.length > 240) return invalid();
  const snapshotStage = enumValue(o.stage, ["staging", "prod"]), snapshotGeneration = finiteInt(o.generation);
  const ticks: ObserverTick[] = o.ticks.map((v: unknown) => {
    if (!Array.isArray(v) || v.length !== 13) return invalid();
    const stage = enumValue(v[0], ["staging", "prod"]), candidate = release(v[1]);
    const generation = finiteInt(v[2]), slot = finiteInt(v[3], watermark), attempt = finiteInt(v[4], 4), start = finiteInt(v[5], generated);
    const terminal = v[6] === null ? null : finiteInt(v[6], generated);
    const outcome = v[7] === null ? null : finiteInt(v[7], 2);
    if (stage !== snapshotStage || generation > snapshotGeneration || !attempt || slot % 60_000 || start < slot || (terminal !== null && terminal < start) || (terminal === null) !== (outcome === null)) return invalid();
    return [stage, candidate, generation, slot, attempt, start, terminal, outcome,
      finiteInt(v[8], 4), finiteInt(v[9], 4), finiteInt(v[10], 4), finiteInt(v[11], 4), finiteInt(v[12], 4)];
  });
  if (new Set(ticks.map(t => `${t[3]}/${t[4]}`)).size !== ticks.length) return invalid();
  for (let i = 1; i < ticks.length; i++) if (ticks[i][3] < ticks[i - 1][3] ||
    (ticks[i][3] === ticks[i - 1][3] && ticks[i][4] <= ticks[i - 1][4])) return invalid();
  return { version: 1, generated, stage: enumValue(o.stage, ["staging", "prod"]), candidate: release(o.candidate),
    generation: finiteInt(o.generation), maintenance: enumValue(o.maintenance, ["open", "held", "recorded", "verified"]),
    watermark, partial: o.partial, activation: null, coverage: "unknown", route: enumValue(o.route, ["disabled", "ready", "blocked_unknown", "rate_limited"]), ticks };
}
