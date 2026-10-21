/**
 * Report context: the reviewed, removable facts a Reporter sends with a
 * Support request (docs/support-context-design.md). WordPress collects and
 * reviews them; the service accepts only this approved schema, freezes it
 * with the create intent and renders it into the issue body.
 */

/** Limits shared with WordPress through contract/fixtures/context.json. */
export const CONTEXT_LIMITS = {
  schema: 1,
  /** UTF-8 bytes of one value; each field's grammar may be tighter. */
  scalarBytes: 256,
  /** UTF-8 bytes of the normalized context, serialized compactly. */
  contextBytes: 6144,
  defaultKeys: 3,
  /** A create carrying context is capped like the browser body: WordPress forwards it unescaped. */
  createBodyBytes: 32_768,
} as const;

const VERSION = /^[0-9][A-Za-z0-9.+_-]{0,63}$/;
const SCREENS = ["dashboard", "post-list", "post-editor", "woocommerce"];
/** Approved default keys, in canonical order. Technical details are not approved in this slice. */
const DEFAULT_FIELDS = {
  wp_version: (value: string) => VERSION.test(value),
  support_plugin_version: (value: string) => VERSION.test(value),
  originating_screen: (value: string) => SCREENS.includes(value),
} as const;
export type ContextKey = keyof typeof DEFAULT_FIELDS;
export interface ReportContext {
  readonly schema: 1;
  readonly default: Readonly<Partial<Record<ContextKey, string>>>;
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The canonical serialization of a submitted context, or null when anything
 * in it is outside the approved schema. Nothing is dropped or truncated: a
 * submitted protocol value is either exactly valid or rejected.
 */
export const canonicalContext = (value: unknown): string | null => {
  if (!isObject(value) || Object.keys(value).some((key) => key !== "schema" && key !== "default")) return null;
  const fields = value.default;
  if (value.schema !== CONTEXT_LIMITS.schema || !isObject(fields)) return null;
  const keys = Object.keys(fields);
  if (keys.length > CONTEXT_LIMITS.defaultKeys || keys.some((key) => !Object.hasOwn(DEFAULT_FIELDS, key))) return null;
  const normalized: Partial<Record<ContextKey, string>> = {};
  for (const [key, valid] of Object.entries(DEFAULT_FIELDS) as [ContextKey, (value: string) => boolean][]) {
    if (!Object.hasOwn(fields, key)) continue;
    const field = fields[key];
    if (typeof field !== "string" || bytes(field) > CONTEXT_LIMITS.scalarBytes || !valid(field)) return null;
    normalized[key] = field;
  }
  const canonical = JSON.stringify({ schema: CONTEXT_LIMITS.schema, default: normalized });
  return bytes(canonical) <= CONTEXT_LIMITS.contextBytes ? canonical : null;
};

const LABELS: Record<ContextKey, string> = {
  wp_version: "WordPress version",
  support_plugin_version: "Support plugin version",
  originating_screen: "Originating admin screen",
};

/**
 * The issue body's Report context section, separate from the Reporter's
 * text, or no lines when nothing was selected. A stored value is validated
 * again, so only grammar-checked values reach the Markdown code spans.
 */
export const contextSection = (stored: string | null): string[] => {
  if (stored === null) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(stored); } catch { return []; }
  const canonical = canonicalContext(parsed);
  if (canonical === null) return [];
  const fields = Object.entries((JSON.parse(canonical) as ReportContext).default) as [ContextKey, string][];
  if (fields.length === 0) return [];
  return ["", "### Report context", "", "Reviewed and sent by the Reporter. The screen is a hint, not evidence of access.", "",
    ...fields.map(([key, value]) => `- ${LABELS[key]}: \`${value}\``)];
};
