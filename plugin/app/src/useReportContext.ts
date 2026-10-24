import { useEffect, useRef, useState } from '@wordpress/element';
import apiFetch from '@wordpress/api-fetch';

/** Approved default Report context fields, in canonical order (docs/support-context-design.md). */
export const CONTEXT_KEYS = ['wp_version', 'support_plugin_version', 'originating_screen'] as const;
export type ContextKey = typeof CONTEXT_KEYS[number];
export type ReportContext = { schema: 1; default: Partial<Record<ContextKey, string>> };
/** What a new intent carries: exactly the selected reviewed values, and the envelope that authorizes them. */
export type Reviewed = { context: ReportContext; context_review: string };

type Session = { paused: boolean; changed: boolean };
/** The draft's Submission ID, and whether a sent intent with it is frozen. */
type Submission = { submissionId: string; pending: boolean };
type Preview = { submissionId: string; context: ReportContext; review: string; omitted: boolean };

/** WordPress's answer to a preview: anything else is a collection failure. */
const previewOf = (submissionId: string, data: unknown): Preview | undefined => {
  const body = data as { state?: unknown; context?: { schema?: unknown; default?: Record<string, unknown> }; review?: unknown; omitted?: unknown } | null;
  const fields = body?.context?.default;
  if (body?.state !== 'current' || body.context?.schema !== 1 || !fields || typeof fields !== 'object' || typeof body.review !== 'string') return undefined;
  const values: ReportContext['default'] = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!(CONTEXT_KEYS as readonly string[]).includes(name) || typeof value !== 'string') return undefined;
    values[name as ContextKey] = value;
  }
  return { submissionId, context: { schema: 1, default: values }, review: body.review, omitted: body.omitted === true };
};

/**
 * The default Report context for the draft's Submission ID: collected by
 * WordPress on explicit open, never while the panel is closed. The Reporter
 * removes any value before sending; a later answer never restores one.
 */
export function useReportContext(visible: boolean, session: Session, { submissionId, pending }: Submission) {
  const [preview, setPreview] = useState<Preview>();
  const [loading, setLoading] = useState(false);
  const [removed, setRemoved] = useState<ContextKey[]>([]);
  // Bumped to ask again for the same Submission ID.
  const [round, setRound] = useState(0);
  // The Submission ID last asked about; a failure is asked about again only on the next open.
  const asked = useRef<string>();
  const generation = useRef(0);

  const load = async (forSubmission: string) => {
    const current = ++generation.current;
    asked.current = forSubmission;
    setLoading(true);
    let result: Preview | undefined;
    try {
      const screen = window.gqSupportLauncher.screen;
      const response = await fetch(window.gqSupportLauncher.ajaxUrl, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000),
        body: new URLSearchParams({
          action: 'gq_support_context', session: window.gqSupportLauncher.session, nonce: apiFetch.nonceMiddleware?.nonce ?? '',
          submission_id: forSubmission, ...(screen ? { screen } : {}),
        }),
      });
      result = previewOf(forSubmission, response.ok ? await response.json() : null);
    } catch {
      // Collection failed: the Reporter can still send without optional information.
    }
    // A late answer after closing, a session change or a newer request changes nothing.
    if (current !== generation.current) return;
    setLoading(false);
    setPreview(result);
  };

  useEffect(() => {
    if (session.changed) {
      generation.current++;
      asked.current = undefined;
      setLoading(false);
      setPreview(undefined);
      setRemoved([]);
      return;
    }
    if (!visible) {
      // Closing abandons a running request and lets the next open ask again after a failure.
      if (loading) { generation.current++; setLoading(false); }
      if (loading || (!preview && !pending)) asked.current = undefined;
      return;
    }
    // A frozen intent sends what it froze: a new answer would show values it does not carry.
    if (session.paused || pending || asked.current === submissionId) return;
    void load(submissionId);
    // `load` is a new function each render; these are the inputs that decide whether to ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, session.paused, session.changed, submissionId, pending, round]);

  const current = preview?.submissionId === submissionId ? preview : undefined;
  const values = current ? CONTEXT_KEYS.filter((name) => current.context.default[name] !== undefined)
    .map((name) => ({ key: name, value: current.context.default[name]!, included: !removed.includes(name) })) : [];
  const selected = values.filter((value) => value.included);
  return {
    loading: loading || (!current && !pending && asked.current !== submissionId && !session.changed),
    /** Nothing reviewable for this draft: offer to send without optional information. */
    failed: !loading && !current && (pending || asked.current === submissionId),
    /** Some value could not be collected and was left out. */
    omitted: current?.omitted ?? false,
    values,
    toggle: (name: ContextKey) => setRemoved((list) => list.includes(name) ? list.filter((item) => item !== name) : [...list, name]),
    removeAll: () => setRemoved([...CONTEXT_KEYS]),
    /** A new report starts with every value included again. */
    reset: () => setRemoved([]),
    /** Ask again for the same Submission ID, after WordPress found its review expired. */
    reload: () => { asked.current = undefined; setPreview(undefined); setRound((value) => value + 1); },
    /** The selected values with their envelope, or nothing when none is selected. */
    reviewed: (): Reviewed | undefined => current && selected.length > 0
      ? { context: { schema: 1, default: Object.fromEntries(selected.map((value) => [value.key, value.value])) }, context_review: current.review }
      : undefined,
  };
}
