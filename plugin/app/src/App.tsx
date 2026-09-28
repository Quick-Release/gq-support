/** @jsxRuntime classic */
/** @jsx createElement */
import { createElement, useEffect, useRef, useState } from "@wordpress/element";
import { __ } from "@wordpress/i18n";
import { speak } from "@wordpress/a11y";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

const textDomain = "gq-support";
const maxDescriptionLength = 5000;
const maxSummaryLength = 200;

type Props = {
  /** Receives the launcher's click action for the current state: open or close. */
  registerToggle: (toggle: () => void) => void;
  /** The launcher owns its own button state; the panel only reports what changed. */
  onVisibilityChange: (visible: boolean, hasDraft: boolean) => void;
};

export function App({ registerToggle, onVisibilityChange }: Props) {
  const [visible, setVisible] = useState(true);
  const [tab, setTab] = useState<"new" | "requests">("new");
  const [description, setDescription] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  const hasDraft = Boolean(description.trim() || summary.trim());

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
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = !description.trim()
      ? __("Enter a description.", textDomain)
      : description.length > maxDescriptionLength || summary.length > maxSummaryLength
        ? __("Your report is too long.", textDomain)
        : __("Sending reports is not available yet.", textDomain);
    setError(message);
    speak(message, "assertive");
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
          <input id="gq-support-summary" className="gq-support-field" value={summary} onChange={(event) => setSummary(event.target.value)} />
          <label htmlFor="gq-support-description" className="gq-support-label">{__("Description", textDomain)}</label>
          <textarea id="gq-support-description" className="gq-support-field gq-support-description" ref={field} required placeholder={__("What happened, and what did you expect?", textDomain)} value={description} onChange={(event) => { setDescription(event.target.value); setError(""); }} />
          {error && <p className="gq-support-error" role="alert">{error}</p>}
          <button type="submit" className="gq-support-submit">{__("Send report", textDomain)}</button>
        </form>
      </div>
      <div id="gq-support-requests" role="tabpanel" aria-labelledby="gq-support-requests-tab" hidden={tab !== "requests"}>
        <p>{__("Requests are not available yet.", textDomain)}</p>
        <button type="button" className="gq-support-link" onClick={() => setTab("new")}>{__("New report", textDomain)}</button>
      </div>
    </section>
  );
}
