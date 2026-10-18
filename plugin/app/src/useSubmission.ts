import { useEffect, useRef, useState } from '@wordpress/element';
import apiFetch from '@wordpress/api-fetch';
import { __ } from '@wordpress/i18n';

type Draft = { summary?: string; description: string };
type Phase = 'draft' | 'sending' | 'checking' | 'received' | 'delivered' | 'failed' | 'unsent' | 'error';
type Session = { paused: boolean; changed: boolean; check: () => Promise<boolean> };
type Resource = { id: string; submission_id: string; delivery: string; status: string | null };
/** Receives the accepted receipt, and the failed request it replaces, if any. */
type Accepted = (resource: Resource, supersedes?: string) => void;

/** One in-memory creation intent. Reconciliation always reuses its frozen body. */
export function useSubmission(visible: boolean, session: Session, accepted: Accepted) {
  const [phase, setPhase] = useState<Phase>('draft');
  const [message, setMessage] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [retryAfter, setRetryAfter] = useState(0);
  const intent = useRef<{ submission_id: string; supersedes_id?: string } & Draft>();
  const supersedes = useRef<string>();
  const busy = useRef(false);
  const unresolved = useRef(false);
  const generation = useRef(0);
  const open = useRef(visible);
  open.current = visible;
  const [waiting, setWaiting] = useState(false);
  const locked = phase === 'sending' || phase === 'checking' || unresolved.current;

  const reset = () => {
    generation.current++;
    intent.current = undefined;
    unresolved.current = false;
    busy.current = false;
    setWaiting(false);
    setPhase('draft');
    setMessage('');
    setAttempts(0);
  };
  useEffect(() => { if (session.changed) { supersedes.current = undefined; reset(); } }, [session.changed]);

  const send = async (draft?: Draft, automatic = false) => {
    if (busy.current || !visible || session.changed) return;
    busy.current = true;
    setWaiting(true);
    const current = generation.current;
    try {
      if (!await session.check()) {
        if (current === generation.current) {
          setPhase('error');
          setMessage(__('Your session expired. Reload the page to continue.', 'gq-support'));
        }
        return;
      }
      if (current !== generation.current || !open.current) return;
      if (!intent.current) {
        if (!draft) return;
        intent.current = { ...draft, submission_id: crypto.randomUUID(), ...(supersedes.current ? { supersedes_id: supersedes.current } : {}) };
        setAttempts(0);
        setRetryAfter(0);
      }
      const payload = intent.current;
      setPhase(unresolved.current ? 'checking' : 'sending');
      setMessage(unresolved.current ? __('Checking…', 'gq-support') : __('Sending…', 'gq-support'));
      try {
        // Raw responses also prevent apiFetch from automatically refreshing a nonce and replaying this write.
        const response = await apiFetch<unknown, false>({ path: '/gq-support/v1/requests', method: 'POST', data: payload, parse: false, signal: AbortSignal.timeout(15000) });
        const resource = await response.json() as Resource;
        if (current !== generation.current) return;
        if (typeof resource.id !== 'string' || !/^req_[0-9A-HJKMNP-TV-Z]{26}$/.test(resource.id) || resource.submission_id !== payload.submission_id || !['delivered', 'accepted-pending', 'failed', 'outcome-unknown'].includes(resource.delivery)) throw new Error('ambiguous');
        if (resource.delivery === 'outcome-unknown') throw new Error('ambiguous');
        if (resource.delivery === 'failed') {
          supersedes.current = resource.id;
          intent.current = undefined;
          unresolved.current = false;
          setPhase('failed');
          setMessage(__('Not sent', 'gq-support'));
        } else {
          supersedes.current = undefined;
          intent.current = undefined;
          unresolved.current = false;
          setPhase(resource.delivery === 'delivered' ? 'delivered' : 'received');
          setMessage(resource.delivery === 'delivered'
            ? resource.status === 'closed' ? __('Closed', 'gq-support') : __('Open', 'gq-support')
            : __('Received', 'gq-support'));
          accepted(resource, payload.supersedes_id);
        }
      } catch (error) {
        if (current !== generation.current) return;
        let code = (error as { code?: string })?.code;
        let delay = 0;
        if (error instanceof Response) {
          const header = error.headers.get('Retry-After');
          if (header) delay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
          try { code = ((await error.json()) as { code?: string })?.code; } catch { code = undefined; }
          // Status remains authoritative when a proxy returns a malformed error body.
          if (error.status === 429) code = 'gq_support_rate_limited';
          if (error.status === 401 || error.status === 403) code = 'rest_not_logged_in';
        }
        if (current !== generation.current) return;
        if (!code || ['gq_support_outcome_unknown', 'fetch_error', 'offline_error', 'invalid_json'].includes(code)) {
          unresolved.current = true;
          setRetryAfter(Number.isFinite(delay) ? Math.max(0, delay) : 0);
          setPhase('checking');
          setMessage(__('Checking…', 'gq-support'));
        } else {
          if (code === 'gq_support_idempotency_conflict') { intent.current = undefined; unresolved.current = false; }
          setPhase(['gq_support_not_accepted', 'gq_support_idempotency_conflict'].includes(code) && !unresolved.current ? 'unsent' : 'error');
          const messages: Record<string, string> = {
            gq_support_rate_limited: __('Too many requests, try again later.', 'gq-support'),
            gq_support_plugin_outdated: __('Support needs a plugin update.', 'gq-support'),
            gq_support_not_configured: __('Support is unavailable.', 'gq-support'),
            // Rejection of this check does not resolve an earlier uncertain send.
            gq_support_not_accepted: unresolved.current ? __('Checking…', 'gq-support') : __('Not sent', 'gq-support'),
            gq_support_idempotency_conflict: __('Not sent', 'gq-support'),
            rest_not_logged_in: __('Your session expired. Reload the page to continue.', 'gq-support'),
            rest_cookie_invalid_nonce: __('Your session expired. Reload the page to continue.', 'gq-support'),
            gq_support_forbidden: __('Your session expired. Reload the page to continue.', 'gq-support'),
          };
          setMessage(messages[code] ?? __('Could not send your report. Try again.', 'gq-support'));
        }
      }
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setWaiting(false);
        if (automatic) setAttempts(value => value + 1);
      }
    }
  };

  useEffect(() => {
    if (!visible || session.paused || phase !== 'checking' || waiting || attempts >= 3) return;
    const timer = window.setTimeout(() => { void send(undefined, true); }, Math.min(2147483647, Math.max(retryAfter, 1000 * 2 ** attempts)));
    return () => window.clearTimeout(timer);
  }, [visible, session.paused, phase, waiting, attempts, retryAfter]);

  // Text can change only before an intent is sent or after its outcome is definite.
  const edit = () => { if (!locked) reset(); };
  return { send, edit, phase, message, locked, waiting, checking: phase === 'checking', retry: phase === 'failed' || phase === 'unsent', checkAgain: unresolved.current && (phase === 'error' || (phase === 'checking' && attempts >= 3)) };
}
