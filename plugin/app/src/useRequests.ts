import { useEffect, useRef, useState } from '@wordpress/element';
import apiFetch from '@wordpress/api-fetch';
import { __ } from '@wordpress/i18n';
import { speak } from '@wordpress/a11y';
import type { SessionCheck } from './useSession';

export type Scope = 'mine' | 'site';
type Delivery = 'accepted-pending' | 'delivered' | 'failed' | 'outcome-unknown';
type Status = 'open' | 'closed';
/** The latest close or reopen and its own delivery outcome; `status` stays GitHub's (ADR 0020). */
export type StatusChange = { change_id: string; status: Status; delivery: Delivery };
export type SupportRequest = {
  id: string;
  title: string;
  summary: string | null;
  description: string;
  created_at: string;
  delivery: Delivery;
  status: Status | null;
  /** WordPress always sends it; a missing one means none. */
  status_change?: StatusChange | null;
  /** Set by WordPress after it verifies ownership: the current Reporter's own request. */
  own: boolean;
};
/**
 * A close or reopen sent from this tab and not yet answered with a receipt. An
 * uncertain one keeps its Change ID, so checking again can never act twice.
 */
export type Action = { change_id: string; status: Status; phase: 'sending' | 'uncertain' | 'error'; message: string };
type Session = { changed: boolean; site: boolean; check: () => Promise<SessionCheck> };
type Phase = 'idle' | 'loading' | 'ready' | 'error';

const PER_PAGE = 20;
const DELIVERY = ['accepted-pending', 'delivered', 'failed', 'outcome-unknown'];
const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

const validChange = (change: unknown): change is StatusChange | null | undefined => {
  if (change === null || change === undefined) return true;
  const value = change as Record<string, unknown> | undefined;
  return !!value && typeof value === 'object' && Object.keys(value).length === 3 && typeof value.change_id === 'string' && UUID4.test(value.change_id)
    && (value.status === 'open' || value.status === 'closed') && DELIVERY.includes(value.delivery as string);
};

/** Only the public resource fields WordPress sends; anything else is malformed. */
const valid = (item: unknown): item is SupportRequest => {
  const value = item as Record<string, unknown> | null;
  return !!value && typeof value.id === 'string' && /^req_[0-9A-HJKMNP-TV-Z]{26}$/.test(value.id)
    && typeof value.title === 'string' && typeof value.description === 'string' && typeof value.created_at === 'string'
    && (value.summary === null || typeof value.summary === 'string') && typeof value.own === 'boolean' && DELIVERY.includes(value.delivery as string)
    && (value.delivery === 'delivered' ? value.status === 'open' || value.status === 'closed' : value.status === null)
    && validChange(value.status_change);
};

/** Why a close or reopen was refused. Only a known refusal frees its Change ID. */
const refusal = (code: string | undefined, status: Status) => {
  const messages: Record<string, string> = {
    gq_support_change_pending: __('An earlier status change for this request is still being delivered. Refresh to see it.', 'gq-support'),
    gq_support_change_not_allowed: __("This request's status can't be changed yet. Refresh to see it.", 'gq-support'),
    gq_support_not_found: __('This request is no longer available. Refresh the list.', 'gq-support'),
    gq_support_not_accepted: status === 'closed'
      ? __("Your close request wasn't sent. Try again.", 'gq-support') : __("Your reopen request wasn't sent. Try again.", 'gq-support'),
    gq_support_idempotency_conflict: __("Couldn't change the status. Try again.", 'gq-support'),
  };
  return messages[code ?? ''] ?? message(code);
};

const message = (code: string | undefined) => {
  const expired = __('Your session expired. Reload the page to continue.', 'gq-support');
  const messages: Record<string, string> = {
    rest_not_logged_in: expired,
    rest_cookie_invalid_nonce: expired,
    gq_support_forbidden: expired,
    gq_support_rate_limited: __('Too many requests, try again later.', 'gq-support'),
    gq_support_plugin_outdated: __('Support needs a plugin update.', 'gq-support'),
    gq_support_not_configured: __('Support is unavailable.', 'gq-support'),
  };
  return messages[code ?? ''] ?? __("Couldn't load. Refresh to try again.", 'gq-support');
};

/**
 * The Reporter issue list. It loads only when asked (My requests shown, Refresh,
 * Show more, a scope change) and never polls. Data stays with the session that
 * read it: a changed session or a lost site grant drops it.
 */
export function useRequests(session: Session) {
  const [scope, setScope] = useState<Scope>('mine');
  const [phase, setPhase] = useState<Phase>('idle');
  const [items, setItems] = useState<SupportRequest[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [refreshed, setRefreshed] = useState(false);
  const generation = useRef(0);
  // Read by add(), which a submission may call from an older render.
  const loaded = useRef(false);
  loaded.current = phase !== 'idle';
  // Receipts accepted while a first page was in flight; that page may predate them.
  const receipts = useRef<SupportRequest[]>([]);
  const [actions, setActions] = useState<Record<string, Action>>({});
  // Read by changeStatus(), so a double click cannot send twice before a render.
  const acting = useRef<Record<string, Action>>({});
  const act = (id: string, action: Action | null) => {
    const { [id]: _previous, ...rest } = acting.current;
    acting.current = action ? { ...rest, [id]: action } : rest;
    setActions(acting.current);
  };

  const clear = (nextScope: Scope = 'mine') => {
    generation.current++;
    receipts.current = [];
    acting.current = {};
    setActions({});
    setScope(nextScope);
    setPhase('idle');
    setItems([]);
    setNext(null);
    setError('');
    setRefreshed(false);
  };
  useEffect(() => { if (session.changed) clear(); }, [session.changed]);
  useEffect(() => { if (!session.site && scope === 'site') clear(); }, [session.site, scope]);

  const fetchPage = async (target: Scope, cursor: string | null, manual: boolean) => {
    if (session.changed || (target === 'site' && !session.site)) return;
    const current = ++generation.current;
    setPhase('loading');
    setError('');
    setRefreshed(false);
    const query = new URLSearchParams({ scope: target, per_page: String(PER_PAGE), ...(cursor ? { cursor } : {}) });
    try {
      // Raw responses keep the HTTP status authoritative when an error body is malformed.
      const response = await apiFetch<unknown, false>({ path: `/gq-support/v1/requests?${query}`, parse: false, signal: AbortSignal.timeout(15000) });
      const body = await response.json() as { items?: unknown; next_cursor?: unknown };
      if (current !== generation.current) return;
      if (!Array.isArray(body?.items) || !body.items.every(valid) || (body.next_cursor !== null && typeof body.next_cursor !== 'string')) throw new Error('malformed');
      const page = body.items;
      const fresh = receipts.current.filter(receipt => !page.some(item => item.id === receipt.id));
      setItems(previous => cursor ? [...previous, ...page.filter(item => !previous.some(known => known.id === item.id))] : [...fresh, ...page]);
      setNext(body.next_cursor as string | null);
      // A fresh read supersedes refusals; an uncertain action keeps its key until checked again.
      if (!cursor) {
        acting.current = Object.fromEntries(Object.entries(acting.current).filter(([, action]) => action.phase !== 'error'));
        setActions(acting.current);
      }
      setPhase('ready');
      setRefreshed(manual);
    } catch (failure) {
      if (current !== generation.current) return;
      let code = (failure as { code?: string })?.code;
      if (failure instanceof Response) {
        try { code = ((await failure.json()) as { code?: string })?.code; } catch { code = undefined; }
        if (failure.status === 401 || failure.status === 403) code = 'rest_not_logged_in';
        if (failure.status === 429) code = 'gq_support_rate_limited';
      }
      if (current !== generation.current) return;
      // Already rendered items stay: they belong to this session, and the error says they may be stale.
      setPhase('error');
      setError(message(code));
    }
  };

  const replace = (item: SupportRequest) => {
    receipts.current = receipts.current.map(known => known.id === item.id ? item : known);
    setItems(previous => previous.map(known => known.id === item.id ? item : known));
  };

  /**
   * One explicit close or reopen. A new action gets a new Change ID. Checking an
   * uncertain one again resends its Change ID and status, which the service can
   * only ever accept once. Nothing here retries on its own or after reauthentication.
   */
  const changeStatus = async (item: SupportRequest, requested: Status) => {
    const previous = acting.current[item.id];
    if (previous?.phase === 'sending' || session.changed) return;
    // Only an uncertain or not-accepted action keeps its key; a refusal spends it.
    const again = previous?.phase === 'uncertain' ? previous : undefined;
    const status = again?.status ?? requested;
    const changeId = again?.change_id ?? crypto.randomUUID();
    const action = (outcome: Action['phase'], text: string): Action => ({ change_id: changeId, status, phase: outcome, message: text });
    const current = generation.current;
    act(item.id, action('sending', again ? __('Checking…', 'gq-support') : status === 'closed' ? __('Closing…', 'gq-support') : __('Reopening…', 'gq-support')));
    const finish = (settled: Action | null, announce: string) => {
      if (current !== generation.current) return;
      act(item.id, settled);
      speak(announce, settled ? 'assertive' : 'polite');
    };
    const checked = await session.check();
    if (checked !== 'current') {
      const text = checked === 'unreachable'
        ? __("Couldn't reach this site. Check your connection and try again.", 'gq-support')
        : __('Your session expired. Reload the page to continue.', 'gq-support');
      // Nothing was sent, so an uncertain action stays uncertain under its own key.
      return finish(action(again ? 'uncertain' : 'error', text), text);
    }
    try {
      // Raw responses also stop apiFetch from refreshing a nonce and replaying this write.
      const response = await apiFetch<unknown, false>({ path: `/gq-support/v1/requests/${encodeURIComponent(item.id)}/status`, method: 'POST',
        data: { change_id: changeId, status }, parse: false, signal: AbortSignal.timeout(15000) });
      const body = await response.json() as SupportRequest;
      if (!valid(body) || body.id !== item.id || body.status_change?.change_id !== changeId || body.status_change.status !== status
        || (response.status === 200) !== (body.status_change.delivery === 'delivered')) throw new Error('malformed');
      if (current !== generation.current) return;
      replace(body);
      finish(null, status === 'closed' ? __('Close requested.', 'gq-support') : __('Reopen requested.', 'gq-support'));
    } catch (failure) {
      let code: string | undefined;
      if (failure instanceof Response) {
        try { code = ((await failure.json()) as { code?: string })?.code; } catch { code = undefined; }
        if (failure.status === 401 || failure.status === 403) code = 'rest_not_logged_in';
        if (failure.status === 429) code = 'gq_support_rate_limited';
      }
      // A timeout, a malformed reply or a 504 says nothing about whether the service recorded the change.
      if (!(failure instanceof Response) || failure.status === 504) {
        const text = __("We couldn't confirm this status change. Check again; it is never applied twice.", 'gq-support');
        return finish(action('uncertain', text), text);
      }
      const text = refusal(code, status);
      finish(action(code === 'gq_support_not_accepted' ? 'uncertain' : 'error', text), text);
    }
  };

  return {
    scope, phase, items, error, refreshed, actions, changeStatus,
    more: next !== null,
    loading: phase === 'loading',
    /** The first load when My requests is shown; later views reuse it. */
    show: () => { if (phase === 'idle') void fetchPage(scope, null, false); },
    refresh: () => { void fetchPage(scope, null, true); },
    loadMore: () => { if (next) void fetchPage(scope, next, false); },
    choose: (target: Scope) => {
      if (target === scope) return;
      clear(target);
      void fetchPage(target, null, false);
    },
    /**
     * An accepted receipt joins a loaded list, or the first page once it loads; a replacement
     * hides its failed predecessor.
     */
    add: (item: unknown, supersedes?: string) => {
      if (!valid(item)) return;
      receipts.current = [item, ...receipts.current.filter(known => known.id !== item.id)];
      if (loaded.current) setItems(previous => [item, ...previous.filter(known => known.id !== item.id && known.id !== supersedes)]);
    },
  };
}
