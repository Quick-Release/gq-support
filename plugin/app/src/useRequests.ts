import { useEffect, useRef, useState } from '@wordpress/element';
import apiFetch from '@wordpress/api-fetch';
import { __ } from '@wordpress/i18n';

export type Scope = 'mine' | 'site';
export type SupportRequest = {
  id: string;
  title: string;
  summary: string | null;
  description: string;
  created_at: string;
  delivery: 'accepted-pending' | 'delivered' | 'failed' | 'outcome-unknown';
  status: 'open' | 'closed' | null;
  /** Set by WordPress after it verifies ownership: the current Reporter's own request. */
  own: boolean;
};
type Session = { changed: boolean; site: boolean };
type Phase = 'idle' | 'loading' | 'ready' | 'error';

const PER_PAGE = 20;
const DELIVERY = ['accepted-pending', 'delivered', 'failed', 'outcome-unknown'];

/** Only the public resource fields WordPress sends; anything else is malformed. */
const valid = (item: unknown): item is SupportRequest => {
  const value = item as Record<string, unknown> | null;
  return !!value && typeof value.id === 'string' && /^req_[0-9A-HJKMNP-TV-Z]{26}$/.test(value.id)
    && typeof value.title === 'string' && typeof value.description === 'string' && typeof value.created_at === 'string'
    && (value.summary === null || typeof value.summary === 'string') && typeof value.own === 'boolean' && DELIVERY.includes(value.delivery as string)
    && (value.delivery === 'delivered' ? value.status === 'open' || value.status === 'closed' : value.status === null);
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

  const clear = (nextScope: Scope = 'mine') => {
    generation.current++;
    receipts.current = [];
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

  return {
    scope, phase, items, error, refreshed,
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
    /** An accepted receipt joins a loaded list; a replacement hides its failed predecessor. */
    add: (item: unknown, supersedes?: string) => {
      if (!loaded.current || !valid(item)) return;
      receipts.current = [item, ...receipts.current.filter(known => known.id !== item.id)];
      setItems(previous => [item, ...previous.filter(known => known.id !== item.id && known.id !== supersedes)]);
    },
  };
}
