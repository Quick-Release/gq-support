import { useEffect, useRef, useState } from '@wordpress/element';
import apiFetch from '@wordpress/api-fetch';
import { __ } from '@wordpress/i18n';

declare global {
  interface Window {
    gqSupportLauncher: {
      session: string; ajaxUrl: string; timezone?: string; help?: { url: string; label: string } | null;
      /** The coarse screen the launcher was rendered on, if approved; never a URL. */
      screen?: string | null;
      /** New intake under the release policy WordPress cached; `closed` only for an outdated plugin. */
      intake?: 'open' | 'closed' | 'unknown';
    };
  }
}

/** Focus and visibility changes start at most one session check per this interval. */
const ACTIVITY_INTERVAL = 5000;

/**
 * A session check's answer. `unreachable` means WordPress could not be asked, which proves
 * nothing about the session; `denied` means it answered without a current grant.
 */
export type SessionCheck = 'current' | 'unreachable' | 'denied' | 'changed';

/**
 * Revalidate on user activity. Never polls, retries a write, or adopts a new session.
 * Leaving the page unmounts the app (index.tsx), so departure needs no handling here.
 */
export function useSession(visible: boolean) {
  const [status, setStatus] = useState<SessionCheck | 'checking'>('checking');
  const [site, setSite] = useState(false);
  const changedRef = useRef(false);
  const pending = useRef<Promise<SessionCheck>>();
  const lastActivity = useRef(0);
  const check = (): Promise<SessionCheck> => {
    if (changedRef.current) return Promise.resolve('changed');
    if (pending.current) return pending.current;
    setStatus('checking');
    pending.current = (async (): Promise<SessionCheck> => {
      let result: SessionCheck = 'unreachable';
      try {
        const url = new URL(window.gqSupportLauncher.ajaxUrl);
        url.searchParams.set('action', 'gq_support_session');
        url.searchParams.set('session', window.gqSupportLauncher.session);
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
        const body = response.ok ? await response.json() as { state?: string; nonce?: string; site?: boolean } : null;
        if (body?.state === 'changed') {
          changedRef.current = true;
          result = 'changed';
        } else if (body?.state === 'current' && body.nonce) {
          if (apiFetch.nonceMiddleware) apiFetch.nonceMiddleware.nonce = body.nonce;
          result = 'current';
        } else if (body) {
          result = 'denied';
        }
        // Only a current session can carry the Support manager grant.
        setSite(result === 'current' && body?.site === true);
      } catch {
        // An unconfirmed session carries no Support manager grant.
        setSite(false);
      } finally {
        pending.current = undefined;
      }
      setStatus(result);
      return result;
    })();
    return pending.current;
  };
  useEffect(() => {
    if (!visible) return;
    const recheck = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastActivity.current < ACTIVITY_INTERVAL) return;
      lastActivity.current = Date.now();
      void check();
    };
    // Opening the panel is an explicit action, so it always checks.
    lastActivity.current = Date.now();
    void check();
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [visible]);
  const changed = status === 'changed';
  return {
    check, changed,
    /** Wait: a check is running, or WordPress refused the session. An unreachable site leaves explicit actions available, since each one checks again. */
    paused: status === 'checking' || status === 'denied' || changed,
    /** WordPress refused or replaced the session: only a reload helps. */
    blocked: status === 'denied' || changed,
    /** A fresh view-site grant from the latest session check. */
    site,
    message: __('Your session needs checking. Reload the page to continue.', 'gq-support'),
  };
}
