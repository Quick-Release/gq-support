/** @jsxRuntime classic */
/** @jsx createElement */
import { createElement, useEffect, useRef, useState } from "@wordpress/element";
import { __ } from "@wordpress/i18n";
import { speak } from "@wordpress/a11y";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

const domain = "gq-support";
const maxLength = 5000;

export function App({ registerOpen }: { registerOpen: (open: () => void) => void }) {
  const [visible, setVisible] = useState(true);
  const [tab, setTab] = useState<"new" | "requests">("new");
  const [description, setDescription] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const launcher = document.querySelector<HTMLButtonElement>(".gq-support-launcher");

  const close = () => {
    setVisible(false);
    launcher?.setAttribute("aria-expanded", "false");
    const indicator = launcher?.querySelector<HTMLElement>(".gq-support-draft-indicator");
    if (indicator) indicator.hidden = !description.trim() && !summary.trim();
    launcher?.focus();
  };
  useEffect(() => {
    registerOpen(() => { setVisible(true); setTab("new"); });
  }, [registerOpen]);
  useEffect(() => {
    launcher?.setAttribute("aria-expanded", String(visible));
    if (visible) {
      const indicator = launcher?.querySelector<HTMLElement>(".gq-support-draft-indicator");
      if (indicator) indicator.hidden = true;
      field.current?.focus();
    }
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && document.getElementById("gq-support-panel")?.contains(document.activeElement)) { event.preventDefault(); close(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const tabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "new" : event.key === "End" ? "requests"
      : event.key === "ArrowRight" ? (tab === "new" ? "requests" : "new")
      : (tab === "new" ? "requests" : "new");
    setTab(next);
    document.getElementById(`gq-support-${next}-tab`)?.focus();
  };
  const validate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = !description.trim()
      ? __("Enter a description.", domain)
      : description.length > maxLength || summary.length > 200
        ? __("Your report is too long.", domain)
        : __("Sending reports is not available yet.", domain);
    setError(message);
    speak(message, "assertive");
  };
  return visible ? (
    <section id="gq-support-panel" className="gq-support-panel" role="dialog" aria-modal="false" aria-labelledby="gq-support-title">
      <div className="gq-support-header">
        <h2 id="gq-support-title">{__("Support", domain)}</h2>
        <button type="button" className="gq-support-close" onClick={close} aria-label={__("Close support", domain)}>×</button>
      </div>
      <div className="gq-support-tabs" role="tablist" aria-label={__("Support views", domain)}>
        <button type="button" role="tab" id="gq-support-new-tab" aria-controls="gq-support-new" aria-selected={tab === "new"} tabIndex={tab === "new" ? 0 : -1} onKeyDown={tabKeyDown} onClick={() => setTab("new")}>{__("New report", domain)}</button>
        <button type="button" role="tab" id="gq-support-requests-tab" aria-controls="gq-support-requests" aria-selected={tab === "requests"} tabIndex={tab === "requests" ? 0 : -1} onKeyDown={tabKeyDown} onClick={() => setTab("requests")}>{__("My requests", domain)}</button>
      </div>
      <div id="gq-support-new" role="tabpanel" aria-labelledby="gq-support-new-tab" hidden={tab !== "new"}>
        <form onSubmit={validate} noValidate>
          <label htmlFor="gq-support-summary">{__("Summary (optional)", domain)}</label>
          <input id="gq-support-summary" value={summary} onChange={(event) => setSummary(event.target.value)} />
          <label htmlFor="gq-support-description">{__("Description", domain)}</label>
          <textarea id="gq-support-description" ref={field} required placeholder={__("What happened, and what did you expect?", domain)} value={description} onChange={(event) => { setDescription(event.target.value); setError(""); }} />
          {error && <p className="gq-support-error" role="alert">{error}</p>}
          <button type="submit">{__("Send report", domain)}</button>
        </form>
      </div>
      <div id="gq-support-requests" role="tabpanel" aria-labelledby="gq-support-requests-tab" hidden={tab !== "requests"}>
        <p>{__("Requests are not available yet.", domain)}</p>
        <button type="button" onClick={() => setTab("new")}>{__("New report", domain)}</button>
      </div>
    </section>
  ) : null;
}
