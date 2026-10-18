/** @jsxRuntime classic */
/** @jsx createElement */
import { createElement, useEffect, useRef, useState } from "@wordpress/element";
import { __ } from "@wordpress/i18n";
import { limits } from "./limits";
import { useSubmission } from "./useSubmission";
import { useSession } from "./useSession";
import { useRequests } from "./useRequests";
import { Requests } from "./Requests";
import { speak } from "@wordpress/a11y";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

const textDomain = "gq-support";
const maxDescriptionLength = limits.description;
const maxSummaryLength = limits.summary;

type Props = {
  /** Receives the launcher's click action for the current state: open or close. */
  registerToggle: (toggle: () => void) => void;
  /** The launcher owns its own button state; the panel only reports what changed. */
  onVisibilityChange: (visible: boolean, hasDraft: boolean) => void;
};

export function App({ registerToggle, onVisibilityChange }: Props) {
  const [visible, setVisible] = useState(true);
  const session = useSession(visible);
  const [tab, setTab] = useState<"new" | "requests">("new");
  const [description, setDescription] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");
  const requests = useRequests(session);
  const submission = useSubmission(visible, session, (resource, supersedes) => {
    setDescription(""); setSummary("");
    requests.add(resource, supersedes);
  });
  const field = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  const hasDraft = Boolean(description.trim() || summary.trim());

  useEffect(() => {
    if (session.changed) { setDescription(""); setSummary(""); setError(""); }
  }, [session.changed]);
  useEffect(() => onVisibilityChange(visible, hasDraft), [hasDraft]);
  // The list loads the first time My requests is shown; reopening reuses it.
  useEffect(() => { if (visible && tab === "requests" && !session.changed) requests.show(); }, [visible, tab, requests.phase, session.changed]);
  const open = () => { setTab("new"); setVisible(true); };
  const close = () => setVisible(false);
  useEffect(() => registerToggle(visible ? close : open));
  useEffect(() => {
    onVisibilityChange(visible, hasDraft);
    if (visible) field.current?.focus();
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && panel.current?.contains(document.activeElement)) { event.preventDefault(); close(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible]);
  const tabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    // With two tabs, both arrow keys move to the other one.
    const next = event.key === "Home" ? "new" : event.key === "End" ? "requests" : tab === "new" ? "requests" : "new";
    setTab(next);
    document.getElementById(`gq-support-${next}-tab`)?.focus();
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submission.locked) return;
    const draft = { ...(summary.trim() ? { summary: summary.trim() } : {}), description: description.trim() };
    const message = !draft.description
      ? __("Enter a description.", textDomain)
      : [...draft.description].length > maxDescriptionLength || [...summary.trim()].length > maxSummaryLength
        ? __("Your report is too long.", textDomain)
        : /[\r\n]/.test(summary.trim())
          ? __("Summary must be one line.", textDomain)
          : new TextEncoder().encode(JSON.stringify({ ...draft, submission_id: "00000000-0000-4000-8000-000000000000" })).length > limits.bodyBytes
            ? __("Your report is too long.", textDomain) : "";
    setError(message);
    if (message) { speak(message, "assertive"); return; }
    await submission.send(draft);
  };
  return (
    <section ref={panel} id="gq-support-panel" className="gq-support-panel" role="dialog" aria-modal="false" aria-labelledby="gq-support-title" hidden={!visible}>
      <div className="gq-support-header">
        <h2 id="gq-support-title" className="gq-support-title">{__("Support", textDomain)}</h2>
        <button type="button" className="gq-support-close" onClick={close} aria-label={__("Close support", textDomain)}>×</button>
      </div>
      <div className="gq-support-tabs" role="tablist" aria-label={__("Support views", textDomain)}>
        <button type="button" role="tab" className="gq-support-tab" id="gq-support-new-tab" aria-controls="gq-support-new" aria-selected={tab === "new"} tabIndex={tab === "new" ? 0 : -1} onKeyDown={tabKeyDown} onClick={() => setTab("new")}>{__("New report", textDomain)}</button>
        <button type="button" role="tab" className="gq-support-tab" id="gq-support-requests-tab" aria-controls="gq-support-requests" aria-selected={tab === "requests"} tabIndex={tab === "requests" ? 0 : -1} onKeyDown={tabKeyDown} onClick={() => setTab("requests")}>{__("My requests", textDomain)}</button>
      </div>
      <div id="gq-support-new" role="tabpanel" aria-labelledby="gq-support-new-tab" hidden={tab !== "new"}>
        <form onSubmit={submit} noValidate>
          <label htmlFor="gq-support-summary" className="gq-support-label">{__("Summary (optional)", textDomain)}</label>
          <input id="gq-support-summary" className="gq-support-field" value={summary} disabled={submission.locked} onChange={(event) => { submission.edit(); setSummary(event.target.value); }} />
          <label htmlFor="gq-support-description" className="gq-support-label">{__("Description", textDomain)}</label>
          <textarea id="gq-support-description" className="gq-support-field gq-support-description" ref={field} disabled={submission.locked} required placeholder={__("What happened, and what did you expect?", textDomain)} value={description} onChange={(event) => { submission.edit(); setDescription(event.target.value); setError(""); }} />
          {submission.message && <p role="status">{submission.message}</p>}
          {submission.checkAgain && <button type="button" disabled={submission.waiting || session.paused} onClick={() => { void submission.send(); }}>{__("Check again", textDomain)}</button>}
          {error && <p className="gq-support-error" role="alert">{error}</p>}
          {session.paused && <p className="gq-support-error" role="alert">{session.message}</p>}
          {session.paused && hasDraft && <button type="button" onClick={() => { void navigator.clipboard.writeText([summary, description].filter(Boolean).join("\n\n")); }}>{__("Copy draft", textDomain)}</button>}
          <button type="submit" disabled={session.paused || submission.locked || submission.waiting} className="gq-support-submit">{submission.retry ? __("Try again", textDomain) : __("Send report", textDomain)}</button>
        </form>
      </div>
      <div id="gq-support-requests" role="tabpanel" aria-labelledby="gq-support-requests-tab" hidden={tab !== "requests"}>
        <Requests requests={requests} site={session.site} disabled={session.changed} onNewReport={() => setTab("new")} />
      </div>
    </section>
  );
}
