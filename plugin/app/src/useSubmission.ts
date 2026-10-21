import { useEffect, useRef, useState } from '@wordpress/element';
import apiFetch from '@wordpress/api-fetch';
import { __, _n, sprintf } from '@wordpress/i18n';
import type { SessionCheck } from './useSession';

type Draft = { summary?: string; description: string };
type Phase = 'draft' | 'sending' | 'checking' | 'received' | 'delivered' | 'unknown' | 'failed' | 'unsent' | 'error';
type Session = { paused: boolean; changed: boolean; check: () => Promise<SessionCheck> };
type Resource = { id: string; submission_id: string; delivery: string; status: string | null };
/** Receives the accepted receipt, and the failed request it replaces, if any. */
type Accepted = (resource: Resource, supersedes?: string) => void;

/** Automatic same-key checks after an ambiguous send (docs/research/outage-draft-recovery.md). */
const AUTOMATIC_CHECKS = 3;
/** Errors after which the Reporter needs the independent contact, not another click. */
const CONTACT_CODES = ['gq_support_disabled', 'gq_support_not_configured', 'gq_support_plugin_outdated'];

/** A durable receipt: the right key, a known delivery, a status only once delivered, and 201 when delivered or 202 otherwise. */
const acknowledged = (resource: Resource, httpStatus: number, submissionId: string) =>
  typeof resource?.id === 'string' && /^req_[0-9A-HJKMNP-TV-Z]{26}$/.test(resource.id) && resource.submission_id === submissionId
  && ['delivered', 'accepted-pending', 'failed', 'outcome-unknown'].includes(resource.delivery)
  && (resource.delivery === 'delivered' ? resource.status === 'open' || resource.status === 'closed' : resource.status === null)
  && httpStatus === (resource.delivery === 'delivered' ? 201 : 202);

/** One in-memory creation intent. Reconciliation always reuses its frozen body. */
export function useSubmission(visible: boolean, session: Session, accepted: Accepted) {
  const [phase, setPhase] = useState<Phase>('draft');
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const intent = useRef<{ submission_id: string; supersedes_id?: string } & Draft>();
  const supersedes = useRef<string>();
  const busy = useRef(false);
  const unresolved = useRef(false);
  const generation = useRef(0);
  // The earliest time a Retry-After allows the next send, manual or automatic.
  const notBefore = useRef(0);
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
    setContact(false);
    setAttempts(0);
  };
  useEffect(() => { if (session.changed) { supersedes.current = undefined; reset(); } }, [session.changed]);

  const send = async (draft?: Draft, automatic = false) => {
    if (busy.current || !visible || session.changed) return;
    const wait = notBefore.current - Date.now();
    if (!automatic && wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      /* translators: %d: seconds until the service accepts another attempt. */
      setMessage(sprintf(_n('Try again in %d second.', 'Try again in %d seconds.', seconds, 'gq-support'), seconds));
      return;
    }
    busy.current = true;
    setWaiting(true);
    const current = generation.current;
    try {
      const checked = await session.check();
      if (checked !== 'current') {
        if (current !== generation.current) return;
        if (checked === 'unreachable') {
          // Nothing reached WordPress, so an uncertain send stays uncertain; this attempt is still charged.
          if (!unresolved.current) {
            setPhase('error');
            setMessage(__("Couldn't reach this site. Your draft is still here; check your connection and try again.", 'gq-support'));
          }
        } else {
          setPhase('error');
          setMessage(__('Your session expired. Reload the page to continue.', 'gq-support'));
          // A refused session stops automatic checks; only an explicit check resumes.
          if (unresolved.current) setAttempts(AUTOMATIC_CHECKS);
        }
        return;
      }
      if (current !== generation.current || !open.current) return;
      if (!intent.current) {
        if (!draft) return;
        intent.current = { ...draft, submission_id: crypto.randomUUID(), ...(supersedes.current ? { supersedes_id: supersedes.current } : {}) };
        setAttempts(0);
      }
      const payload = intent.current;
      setPhase(unresolved.current ? 'checking' : 'sending');
      setMessage(unresolved.current ? __('Checking…', 'gq-support') : __('Sending…', 'gq-support'));
      setContact(false);
      try {
        // Raw responses also prevent apiFetch from automatically refreshing a nonce and replaying this write.
        const response = await apiFetch<unknown, false>({ path: '/gq-support/v1/requests', method: 'POST', data: payload, parse: false, signal: AbortSignal.timeout(15000) });
        const resource = await response.json() as Resource;
        if (current !== generation.current) return;
        if (!acknowledged(resource, response.status, payload.submission_id)) throw new Error('ambiguous');
        intent.current = undefined;
        unresolved.current = false;
        notBefore.current = 0;
        if (resource.delivery === 'failed') {
          supersedes.current = resource.id;
          setPhase('failed');
          setMessage(__('Not sent', 'gq-support'));
        } else {
          // Accepted intake, including an uncertain GitHub outcome: the service owns it from here.
          supersedes.current = undefined;
          setPhase(resource.delivery === 'delivered' ? 'delivered' : resource.delivery === 'accepted-pending' ? 'received' : 'unknown');
          setMessage(resource.delivery === 'delivered'
            ? resource.status === 'closed' ? __('Closed', 'gq-support') : __('Open', 'gq-support')
            : resource.delivery === 'accepted-pending' ? __('Received', 'gq-support') : __('Delivery needs review', 'gq-support'));
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
        notBefore.current = Number.isFinite(delay) && delay > 0 ? Date.now() + delay : 0;
        if (!code || ['gq_support_outcome_unknown', 'fetch_error', 'offline_error', 'invalid_json'].includes(code)) {
          unresolved.current = true;
          setPhase('checking');
          setMessage(__('Checking…', 'gq-support'));
        } else {
          // A rejected check never proves that an earlier uncertain send failed: keep its key and frozen body.
          if (unresolved.current) setAttempts(AUTOMATIC_CHECKS);
          else if (code === 'gq_support_idempotency_conflict') intent.current = undefined;
          setPhase(['gq_support_not_accepted', 'gq_support_idempotency_conflict'].includes(code) && !unresolved.current ? 'unsent' : 'error');
          setContact(CONTACT_CODES.includes(code) || unresolved.current);
          const messages: Record<string, string> = {
            gq_support_rate_limited: __('Too many requests, try again later.', 'gq-support'),
            gq_support_plugin_outdated: __('Support needs a plugin update.', 'gq-support'),
            gq_support_not_configured: __('Support is unavailable.', 'gq-support'),
            gq_support_disabled: __('Support is temporarily disabled.', 'gq-support'),
            gq_support_not_accepted: unresolved.current ? __('Checking…', 'gq-support') : __('Not sent', 'gq-support'),
            gq_support_idempotency_conflict: unresolved.current
              ? __("We couldn't confirm whether your report arrived. Check My requests before sending it again.", 'gq-support')
              : __('Not sent', 'gq-support'),
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
    if (!visible || session.paused || phase !== 'checking' || waiting || attempts >= AUTOMATIC_CHECKS) return;
    const delay = Math.max(notBefore.current - Date.now(), 1000 * 2 ** attempts);
    const timer = window.setTimeout(() => { void send(undefined, true); }, Math.min(2147483647, delay));
    return () => window.clearTimeout(timer);
  }, [visible, session.paused, phase, waiting, attempts]);

  const checkAgain = unresolved.current && (phase === 'error' || (phase === 'checking' && attempts >= AUTOMATIC_CHECKS));
  // Text can change only before an intent is sent or after its outcome is definite.
  const edit = () => { if (!locked) reset(); };
  return {
    send, edit, phase, message, locked, waiting, checkAgain,
    checking: phase === 'checking',
    retry: phase === 'failed' || phase === 'unsent',
    /** The service holds the report: its outcome shows with the request list. */
    accepted: phase === 'received' || phase === 'delivered' || phase === 'unknown',
    /** Show the independent contact: support is unavailable, or a send stays uncertain. */
    contact: contact || checkAgain,
  };
}
