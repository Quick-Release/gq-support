/** @jsxRuntime classic */
/** @jsx createElement */
import { createElement, useEffect, useState } from "@wordpress/element";
import { __ } from "@wordpress/i18n";
import { speak } from "@wordpress/a11y";
import type { Action, Scope, SupportRequest, useRequests } from "./useRequests";

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
  ? item.status === "closed" ? __("Closed", "gq-support") : __("Open", "gq-support")
  : item.delivery === "accepted-pending" ? __("Received", "gq-support")
    : item.delivery === "failed" ? __("Not sent", "gq-support") : __("Delivery needs review", "gq-support");

const hint = (item: SupportRequest) => item.delivery === "accepted-pending" ? __("Delivery is pending", "gq-support")
  : item.delivery === "outcome-unknown" ? __("Our team is checking whether this report arrived. Refresh to see its status.", "gq-support") : "";

/**
 * A close or reopen's own delivery, beside the GitHub-backed badge (ADR 0020).
 * A delivered change needs no words: the badge already shows GitHub's status.
 */
const changeHint = (item: SupportRequest) => {
  const change = item.status_change;
  if (!change) return "";
  const close = change.status === "closed";
  if (change.delivery === "accepted-pending") return close ? __("Close requested. Delivery is pending.", "gq-support") : __("Reopen requested. Delivery is pending.", "gq-support");
  if (change.delivery === "outcome-unknown") {
    return close ? __("Our team is checking whether your close request arrived. Refresh to see its status.", "gq-support")
      : __("Our team is checking whether your reopen request arrived. Refresh to see its status.", "gq-support");
  }
  if (change.delivery === "failed" && change.status !== item.status) {
    return close ? __("Your close request couldn't be confirmed. You can try again.", "gq-support")
      : __("Your reopen request couldn't be confirmed. You can try again.", "gq-support");
  }
  return "";
};

/** Close or reopen is offered once delivered, while no earlier change or uncertain action is outstanding. */
const canChange = (item: SupportRequest, action: Action | undefined) => item.delivery === "delivered" && !action
  && (!item.status_change || item.status_change.delivery === "delivered" || item.status_change.delivery === "failed");

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
  const updated = __("Requests updated.", "gq-support");
  useEffect(() => { if (requests.refreshed) speak(updated); }, [requests.refreshed, updated]);
  const status = requests.loading ? __("Loading requests…", "gq-support") : requests.refreshed ? updated : "";
  return (
    <div className="gq-support-requests">
      <div className="gq-support-toolbar">
        {site && (
          <label className="gq-support-scope" htmlFor="gq-support-scope">
            {__("Show", "gq-support")}{" "}
            <select id="gq-support-scope" value={requests.scope} disabled={disabled || requests.loading} onChange={(event) => requests.choose(event.target.value as Scope)}>
              <option value="mine">{__("My requests", "gq-support")}</option>
              <option value="site">{__("All requests on this site", "gq-support")}</option>
            </select>
          </label>
        )}
        <button type="button" className="gq-support-refresh" disabled={disabled || requests.loading} onClick={requests.refresh}>{__("Refresh", "gq-support")}</button>
      </div>
      <p role="status" className="gq-support-status">{status}</p>
      {phase === "error" && <p className="gq-support-error" role="alert">{error}</p>}
      {phase === "ready" && items.length === 0 && (
        <p>
          {__("No requests yet", "gq-support")}{" "}
          <button type="button" className="gq-support-link" onClick={onNewReport}>{__("New report", "gq-support")}</button>
        </p>
      )}
      {items.length > 0 && (
        <ul className="gq-support-list">
          {items.map((item) => {
            const open = expanded === item.id;
            const action = requests.actions[item.id];
            const details = `gq-support-request-${item.id}`;
            return (
              <li key={item.id} className="gq-support-item">
                <button type="button" className="gq-support-item-toggle" aria-expanded={open} aria-controls={details} onClick={() => setExpanded(open ? null : item.id)}>
                  <span className="gq-support-item-title">{item.title}</span>
                  {requests.scope === "site" && item.own && <span className="gq-support-badge">{__("Yours", "gq-support")}</span>}
                  <span className={`gq-support-badge gq-support-badge-${item.delivery === "delivered" ? item.status : item.delivery}`}>{badge(item)}</span>
                </button>
                <div id={details} className="gq-support-item-details" hidden={!open}>
                  {hint(item) && <p className="gq-support-hint">{hint(item)}</p>}
                  <p className="gq-support-item-text">{item.description}</p>
                  <p className="gq-support-hint">{formatDate(item.created_at)}</p>
                  {changeHint(item) && <p className="gq-support-hint">{changeHint(item)}</p>}
                  {action && <p className={action.phase === "sending" ? "gq-support-hint" : "gq-support-error"}>{action.message}</p>}
                  {(canChange(item, action) || action?.phase === "error") && (
                    <button type="button" className="gq-support-change" disabled={disabled} onClick={() => { void requests.changeStatus(item, item.status === "closed" ? "open" : "closed"); }}>
                      {item.status === "closed" ? __("Reopen request", "gq-support") : __("Close request", "gq-support")}
                    </button>
                  )}
                  {action?.phase === "uncertain" && (
                    <button type="button" className="gq-support-change" disabled={disabled} onClick={() => { void requests.changeStatus(item, action.status); }}>{__("Check again", "gq-support")}</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {requests.more && <button type="button" className="gq-support-link" disabled={disabled || requests.loading} onClick={requests.loadMore}>{__("Show more", "gq-support")}</button>}
    </div>
  );
}
