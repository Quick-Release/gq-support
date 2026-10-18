import { useEffect, useRef, useState } from '@wordpress/element';
import apiFetch from '@wordpress/api-fetch';
import { __ } from '@wordpress/i18n';

declare global {
  interface Window {
    gqSupportLauncher: { session: string; ajaxUrl: string; timezone?: string };
  }
}

/** Revalidate on user activity. Never polls, retries a write, or adopts a new session. */
export function useSession(visible: boolean) {
  const [paused, setPaused] = useState(true);
  const [changed, setChanged] = useState(false);
  const [site, setSite] = useState(false);
  const changedRef = useRef(false);
  const pending = useRef<Promise<boolean>>();
  const check = (): Promise<boolean> => {
    if (changedRef.current) return Promise.resolve(false);
    if (pending.current) return pending.current;
    setPaused(true);
    pending.current = (async () => {
      try {
        const url = new URL(window.gqSupportLauncher.ajaxUrl);
        url.searchParams.set('action', 'gq_support_session');
        url.searchParams.set('session', window.gqSupportLauncher.session);
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!response.ok) return false;
        const result = await response.json() as { state?: string; nonce?: string; site?: boolean };
        if (result.state === 'changed') {
          changedRef.current = true;
          setChanged(true);
          setSite(false);
          return false;
        }
        // Only a current session can carry the Support manager grant.
        setSite(result.state === 'current' && result.site === true);
        if (result.state !== 'current' || !result.nonce) return false;
        if (apiFetch.nonceMiddleware) apiFetch.nonceMiddleware.nonce = result.nonce;
        setPaused(false);
        return true;
      } catch {
        return false;
      } finally {
        pending.current = undefined;
      }
    })();
    return pending.current;
  };
  useEffect(() => {
    if (!visible) return;
    const recheck = () => { if (document.visibilityState === 'visible') void check(); };
    void check();
    const leave = () => { changedRef.current = true; setChanged(true); setSite(false); setPaused(true); };
    window.addEventListener('pagehide', leave);
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [visible]);
  return {
    check, paused, changed,
    /** A fresh view-site grant from the latest session check. */
    site,
    message: __('Your session needs checking. Reload the page to continue.', 'gq-support'),
  };
}
