/** @jsxRuntime classic */
/** @jsx createElement */
import { createElement, useEffect, useState } from "@wordpress/element";
import { __ } from "@wordpress/i18n";
import { speak } from "@wordpress/a11y";
import type { Scope, SupportRequest, useRequests } from "./useRequests";

const textDomain = "gq-support";

type Props = {
  requests: ReturnType<typeof useRequests>;
  /** The session can carry the Support manager grant for this installation. */
  site: boolean;
  /** No reads once the session has changed. */
  disabled: boolean;
  onNewReport: () => void;
};

/** One honest badge per item (docs/support-domain-design.md, Reporter experience). */
const badge = (item: SupportRequest) => item.delivery === "delivered"
  ? item.status === "closed" ? __("Closed", textDomain) : __("Open", textDomain)
  : item.delivery === "accepted-pending" ? __("Received", textDomain)
    : item.delivery === "failed" ? __("Not sent", textDomain) : __("Delivery needs review", textDomain);

const hint = (item: SupportRequest) => item.delivery === "accepted-pending" ? __("Delivery is pending", textDomain)
  : item.delivery === "outcome-unknown" ? __("Our team is checking whether this report arrived. Refresh to see its status.", textDomain) : "";

// The site timezone, when the browser knows it; the browser's own otherwise.
const formatDate = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const locale = document.documentElement.lang || undefined;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: window.gqSupportLauncher.timezone || undefined }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }
};

export function Requests({ requests, site, disabled, onNewReport }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const { phase, items, error } = requests;
  useEffect(() => { if (error) speak(error, "assertive"); }, [error]);
  const updated = __("Requests updated.", textDomain);
  useEffect(() => { if (requests.refreshed) speak(updated); }, [requests.refreshed]);
  const status = requests.loading ? __("Loading requests…", textDomain) : requests.refreshed ? updated : "";
  return (
    <div className="gq-support-requests">
      <div className="gq-support-toolbar">
        {site && (
          <label className="gq-support-scope">
            {__("Show", textDomain)}{" "}
            <select value={requests.scope} disabled={disabled || requests.loading} onChange={(event) => requests.choose(event.target.value as Scope)}>
              <option value="mine">{__("My requests", textDomain)}</option>
              <option value="site">{__("All requests on this site", textDomain)}</option>
            </select>
          </label>
        )}
        <button type="button" className="gq-support-refresh" disabled={disabled || requests.loading} onClick={requests.refresh}>{__("Refresh", textDomain)}</button>
      </div>
      <p role="status" className="gq-support-status">{status}</p>
      {phase === "error" && <p className="gq-support-error" role="alert">{error}</p>}
      {phase === "ready" && items.length === 0 && (
        <p>
          {__("No requests yet", textDomain)}{" "}
          <button type="button" className="gq-support-link" onClick={onNewReport}>{__("New report", textDomain)}</button>
        </p>
      )}
      {items.length > 0 && (
        <ul className="gq-support-list">
          {items.map((item) => {
            const open = expanded === item.id;
            const details = `gq-support-request-${item.id}`;
            return (
              <li key={item.id} className="gq-support-item">
                <button type="button" className="gq-support-item-toggle" aria-expanded={open} aria-controls={details} onClick={() => setExpanded(open ? null : item.id)}>
                  <span className="gq-support-item-title">{item.title}</span>
                  <span className={`gq-support-badge gq-support-badge-${item.delivery === "delivered" ? item.status : item.delivery}`}>{badge(item)}</span>
                </button>
                <div id={details} className="gq-support-item-details" hidden={!open}>
                  {hint(item) && <p className="gq-support-hint">{hint(item)}</p>}
                  <p className="gq-support-item-text">{item.description}</p>
                  <p className="gq-support-hint">{formatDate(item.created_at)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {requests.more && <button type="button" className="gq-support-link" disabled={disabled || requests.loading} onClick={requests.loadMore}>{__("Show more", textDomain)}</button>}
    </div>
  );
}
