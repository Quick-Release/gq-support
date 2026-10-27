// A non-executable decoder for beta.83 StateEncoding. Native persistence does
// not serialize callback behavior. Apply/Effect/FlatMap expressions therefore
// need a future reviewed serialization contract and always refuse here.
import * as Output from "alchemy/Output";
import { isResource } from "alchemy/Resource";
import * as Redacted from "effect/Redacted";
import * as Duration from "effect/Duration";
import { decodeDuration } from "alchemy/State/StateEncoding";
import { requireEvidence, refusal, checkTarget, type Target } from "./planning-state.ts";
import { MAX_BODY } from "./planning-read.ts";

export interface ReferenceGraph {
  readonly target: Target;
  readonly rows: ReadonlyMap<string, { readonly fqn: string; readonly resourceType?: string; readonly attr?: unknown; readonly output?: unknown }>;
  readonly output: unknown;
}
export function decodeNativeState(value: unknown, graph: ReferenceGraph): unknown {
  checkTarget(graph.target);
  const ancestors = new Set<object>();
  const references = new Set<string>();
  let nodes = 0, size = 0;
  const exact = (obj: Record<string, unknown>, keys: string[]) => requireEvidence(Object.keys(obj).every((k) => keys.includes(k)));
  const visit = (v: unknown, depth: number, nativeExpression = false): unknown => {
    requireEvidence(++nodes <= 100_000 && depth < 64);
    if (Output.isOutput(v)) {
      // Native Output proxies are functions. StateEncoding leaves them as
      // functions and JSON omits them. Only accept actual in-memory native
      // expression nodes; never hydrate a persisted `kind` claim.
      const node = (v as unknown as Record<symbol, unknown>)[Output.ExprSymbol];
      requireEvidence(node instanceof Output.RefExpr || node instanceof Output.StackRefExpr ||
        node instanceof Output.ResourceExpr || node instanceof Output.PropExpr || node instanceof Output.LiteralExpr ||
        node instanceof Output.AllExpr || node instanceof Output.NamedExpr);
      return visit(node, depth + 1, true);
    }
    if (v === null || v === undefined || typeof v === "boolean") return v;
    if (typeof v === "string") { size += Buffer.byteLength(v); requireEvidence(size <= MAX_BODY); return v; }
    if (typeof v === "number") { requireEvidence(Number.isFinite(v)); return v; }
    requireEvidence(typeof v === "object" && !ancestors.has(v));
    ancestors.add(v);
    try {
      if (Redacted.isRedacted(v)) return Object.freeze(Redacted.make(visit(Redacted.value(v), depth + 1)));
      if (Duration.isDuration(v)) {
        requireEvidence(Number.isFinite(Duration.toMillis(v)));
        const duration = decodeDuration(v.toJSON()); requireEvidence(duration);
        Object.freeze(duration.value); return Object.freeze(duration);
      }
      // A frozen Date still has mutable internal slots. The snapshot service
      // returns a fresh clone per read, never its privately held template.
      if (v instanceof Date) { requireEvidence(Number.isFinite(v.getTime())); return Object.freeze(new Date(v.getTime())); }
      requireEvidence(nativeExpression || Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
      for (const key of Reflect.ownKeys(v)) {
        requireEvidence(typeof key === "string" && !["__proto__", "constructor", "prototype"].includes(key));
        if (Array.isArray(v) && key === "length") continue;
        if (Array.isArray(v)) requireEvidence(/^(0|[1-9][0-9]*)$/.test(key));
        const descriptor = Object.getOwnPropertyDescriptor(v, key);
        requireEvidence(descriptor && "value" in descriptor && descriptor.enumerable);
      }
      if (Array.isArray(v)) return Object.freeze(v.map((entry) => visit(entry, depth + 1)));
      const obj = v as Record<string, unknown>;
      const marker = ["__redacted__", "__duration__", "__date__"].find((key) => key in obj);
      if (marker) {
        requireEvidence(Object.keys(obj).length === 1);
        if (marker === "__redacted__") return Object.freeze(Redacted.make(visit(obj[marker], depth + 1)));
        if (marker === "__date__") {
          requireEvidence(typeof obj[marker] === "string");
          const date = new Date(obj[marker]); requireEvidence(Number.isFinite(date.getTime()) && date.toISOString() === obj[marker]);
          return Object.freeze(date);
        }
        const encoded = obj[marker];
        requireEvidence(encoded && typeof encoded === "object" && !Array.isArray(encoded));
        const d = encoded as Record<string, unknown>;
        exact(d, ["_id", "_tag", "millis", "nanos"]);
        requireEvidence(d._id === "Duration" &&
          ((d._tag === "Millis" && typeof d.millis === "number" && Number.isFinite(d.millis) && d.nanos === undefined) ||
           (d._tag === "Nanos" && typeof d.nanos === "string" && /^-?[0-9]{1,30}$/.test(d.nanos) && d.millis === undefined)));
        const duration = decodeDuration(encoded); requireEvidence(duration);
        Object.freeze(duration.value); return Object.freeze(duration);
      }
      requireEvidence(!("_tag" in obj));
      const reference = (id: unknown, stack: unknown, stage: unknown, type?: unknown): unknown => {
        requireEvidence((stack === undefined || stack === graph.target.stack) && (stage === undefined || stage === graph.target.stage) &&
          typeof id === "string" && /^[A-Za-z0-9_~-]+(?:\/[A-Za-z0-9_~-]+)*$/.test(id) && !references.has(id));
        const row = graph.rows.get(id); requireEvidence(row && row.fqn === id && (row.attr !== undefined || row.output !== undefined) && (type === undefined || type === row.resourceType));
        references.add(id);
        try { return visit(row.attr ?? row.output, depth + 1); } finally { references.delete(id); }
      };
      if (typeof obj.kind === "string" && obj.kind.endsWith("Expr")) {
        requireEvidence(nativeExpression);
        switch (obj.kind) {
          case "LiteralExpr": exact(obj, ["kind", "value"]); requireEvidence("value" in obj); return visit(obj.value, depth + 1);
          case "RefExpr": {
            exact(obj, ["kind", "stack", "stage", "resourceId", "stables"]);
            if (obj.stables !== undefined) { requireEvidence(obj.stables && typeof obj.stables === "object"); exact(obj.stables as Record<string, unknown>, ["Type", "LogicalId"]);
              requireEvidence((obj.stables as Record<string, unknown>).LogicalId === undefined || (obj.stables as Record<string, unknown>).LogicalId === obj.resourceId); }
            return reference(obj.resourceId, obj.stack, obj.stage, (obj.stables as Record<string, unknown> | undefined)?.Type);
          }
          case "StackRefExpr":
            exact(obj, ["kind", "stack", "stage"]);
            requireEvidence(obj.stack === graph.target.stack && (obj.stage === undefined || obj.stage === graph.target.stage) && !references.has("$output"));
            references.add("$output");
            try { return visit(graph.output, depth + 1); } finally { references.delete("$output"); }
          case "ResourceExpr": {
            exact(obj, ["kind", "src", "stables"]);
            requireEvidence(isResource(obj.src));
            const src = obj.src;
            return reference(src.FQN, undefined, undefined, src.Type);
          }
          case "PropExpr": {
            exact(obj, ["kind", "expr", "identifier"]);
            requireEvidence(typeof obj.identifier === "string" && !["__proto__", "constructor", "prototype"].includes(obj.identifier));
            const parent = visit(obj.expr, depth + 1);
            requireEvidence(parent && typeof parent === "object" && Object.hasOwn(parent, obj.identifier));
            return (parent as Record<string, unknown>)[obj.identifier];
          }
          case "AllExpr": exact(obj, ["kind", "outs"]); requireEvidence(Array.isArray(obj.outs)); return visit(obj.outs, depth + 1);
          case "NamedExpr": exact(obj, ["kind", "expr", "bindingName"]); requireEvidence(typeof obj.bindingName === "string"); return visit(obj.expr, depth + 1);
          default: requireEvidence(false);
        }
      }
      if ("id" in obj && "type" in obj && "props" in obj) {
        // Native Resource flattening is data, not a revived Resource class.
        // Only this graph's exact root resource identities are supported.
        exact(obj, ["id", "type", "props", "attr"]);
        requireEvidence(typeof obj.id === "string" && graph.rows.get(obj.id)?.resourceType === obj.type &&
          obj.props && typeof obj.props === "object" && (obj.attr === undefined || (obj.attr && typeof obj.attr === "object")));
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, entry] of Object.entries(obj)) {
        size += Buffer.byteLength(key); requireEvidence(size <= MAX_BODY);
        result[key] = visit(entry, depth + 1);
      }
      return Object.freeze(result);
    } finally { ancestors.delete(v); }
  };
  try { return visit(value, 0); } catch { throw refusal(); }
}
