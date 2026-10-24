/** @jsxRuntime classic */
/** @jsx createElement */
import { createElement, useEffect, useRef, useState } from "@wordpress/element";
import { __ } from "@wordpress/i18n";
import { limits } from "./limits";
import { useSubmission } from "./useSubmission";
import { useSession } from "./useSession";
import { useRequests } from "./useRequests";
import { useReportContext, type ContextKey } from "./useReportContext";
import { Requests } from "./Requests";
import { speak } from "@wordpress/a11y";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

const maxDescriptionLength = limits.description;
const maxSummaryLength = limits.summary;

type Props = {
  /** Receives the launcher's click action for the current state: open or close. */
  registerToggle: (toggle: () => void) => void;
  /** The launcher owns its own button state; the panel only reports what changed. */
  onVisibilityChange: (visible: boolean, hasDraft: boolean) => void;
};

/** The Operator-verified contact outside WordPress, validated and escaped by the server. Never carries report text. */
function Contact() {
  const help = window.gqSupportLauncher.help;
  if (!help) return null;
  const external = help.url.toLowerCase().startsWith("https:");
  return (
    <p className="gq-support-hint">
      {__("Need help another way? Contact:", "gq-support")}{" "}
      <a href={help.url} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}>{help.label}</a>
    </p>
  );
}

/** Report context labels; each value is shown exactly as it would be sent. */
const contextLabels = (): Record<ContextKey, string> => ({
  wp_version: __("WordPress version", "gq-support"),
  support_plugin_version: __("Support plugin version", "gq-support"),
  originating_screen: __("Screen you opened support from", "gq-support"),
});

/** What an accepted outcome promises, and no more (docs/research/outage-draft-recovery.md, delivery promise). */
const hint = (phase: string) => phase === "received"
  ? __("The service saved your report and will try to deliver it. Delivery is pending.", "gq-support")
  : phase === "unknown" ? __("The service saved your report, and our team is checking whether it arrived. Don't send it again; refresh to see its status.", "gq-support") : "";

export function App({ registerToggle, onVisibilityChange }: Props) {
  const [visible, setVisible] = useState(true);
  const session = useSession(visible);
  const [tab, setTab] = useState<"new" | "requests">("new");
  const [description, setDescription] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");
  const [copyState, setCopyState] = useState<"" | "copied" | "manual">("");
  const requests = useRequests(session);
  const field = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  const manual = useRef<HTMLTextAreaElement>(null);
  const focusRequests = useRef(false);
  const submission = useSubmission(visible, session, (resource, supersedes) => {
    setDescription(""); setSummary(""); setCopyState("");
    context.reset();
    requests.add(resource, supersedes);
    // The new request is shown on top of My requests (docs/support-domain-design.md, Views).
    // Focus follows only if it was in the panel, where the hidden Send button held it.
    const doc = panel.current?.ownerDocument ?? document;
    focusRequests.current = !!panel.current?.contains(doc.activeElement) || doc.activeElement === doc.body;
    setTab("requests");
  }, () => context.reload());
  const context = useReportContext(visible, session, submission);
  const hasDraft = Boolean(description.trim() || summary.trim());
  const draftText = [summary, description].filter(Boolean).join("\n\n");

  useEffect(() => {
    if (session.changed) { setDescription(""); setSummary(""); setError(""); setCopyState(""); }
  }, [session.changed]);
  // Reports draft changes; the effect on `visible` below reports visibility changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onVisibilityChange(visible, hasDraft), [hasDraft]);
  useEffect(() => { if (submission.accepted) speak(submission.message); }, [submission.accepted, submission.message]);
  useEffect(() => { if (copyState === "manual") manual.current?.select(); }, [copyState]);
  useEffect(() => {
    if (tab === "requests" && focusRequests.current) document.getElementById("gq-support-requests-tab")?.focus();
    focusRequests.current = false;
  }, [tab]);
  // The list loads the first time My requests is shown; reopening reuses it.
  // `requests` is a new object on every render; its phase is what decides whether to load.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (visible && tab === "requests" && !session.changed) requests.show(); }, [visible, tab, requests.phase, session.changed]);
  const open = () => { setTab("new"); setVisible(true); };
  const close = () => setVisible(false);
  useEffect(() => registerToggle(visible ? close : open));
  // Focus moves only when the panel opens, not on every keystroke in the draft.
  useEffect(() => {
    onVisibilityChange(visible, hasDraft);
    if (visible) field.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && panel.current?.contains(panel.current.ownerDocument.activeElement)) { event.preventDefault(); close(); }
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
  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(draftText);
      setCopyState("copied");
      speak(__("Draft copied.", "gq-support"));
    } catch {
      // Clipboard access can be denied: offer the text to select and copy by hand.
      setCopyState("manual");
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submission.locked || context.loading) return;
    const text = { ...(summary.trim() ? { summary: summary.trim() } : {}), description: description.trim() };
    // Exactly the reviewed values still selected; the size check counts them and their envelope.
    const draft = { ...text, ...context.reviewed() };
    const bytes = (body: typeof draft) => new TextEncoder().encode(JSON.stringify(submission.intentFor(body))).length;
    const message = !draft.description
      ? __("Enter a description.", "gq-support")
      : [...draft.description].length > maxDescriptionLength || [...summary.trim()].length > maxSummaryLength
        ? __("Your report is too long.", "gq-support")
        : /[\r\n]/.test(summary.trim())
          ? __("Summary must be one line.", "gq-support")
          : bytes(draft) > limits.bodyBytes
            ? bytes(text) > limits.bodyBytes
              ? __("Your report is too long.", "gq-support")
              : __("Your report is too long to send with the information included. Remove some information, or shorten your report.", "gq-support")
            : "";
    setError(message);
    if (message) { speak(message, "assertive"); return; }
    await submission.send(draft);
  };
  const edit = () => { submission.edit(); setCopyState(""); };
  return (
    <section ref={panel} id="gq-support-panel" className="gq-support-panel" role="dialog" aria-modal="false" aria-labelledby="gq-support-title" hidden={!visible}>
      <div className="gq-support-header">
        <h2 id="gq-support-title" className="gq-support-title">{__("Support", "gq-support")}</h2>
        <button type="button" className="gq-support-close" onClick={close} aria-label={__("Close support", "gq-support")}>×</button>
      </div>
      <div className="gq-support-tabs" role="tablist" aria-label={__("Support views", "gq-support")}>
        <button type="button" role="tab" className="gq-support-tab" id="gq-support-new-tab" aria-controls="gq-support-new" aria-selected={tab === "new"} tabIndex={tab === "new" ? 0 : -1} onKeyDown={tabKeyDown} onClick={() => setTab("new")}>{__("New report", "gq-support")}</button>
        <button type="button" role="tab" className="gq-support-tab" id="gq-support-requests-tab" aria-controls="gq-support-requests" aria-selected={tab === "requests"} tabIndex={tab === "requests" ? 0 : -1} onKeyDown={tabKeyDown} onClick={() => setTab("requests")}>{__("My requests", "gq-support")}</button>
      </div>
      <div id="gq-support-new" role="tabpanel" aria-labelledby="gq-support-new-tab" hidden={tab !== "new"}>
        <form onSubmit={submit} noValidate>
          <label htmlFor="gq-support-summary" className="gq-support-label">{__("Summary (optional)", "gq-support")}</label>
          <input id="gq-support-summary" className="gq-support-field" value={summary} disabled={submission.locked} onChange={(event) => { edit(); setSummary(event.target.value); }} />
          <label htmlFor="gq-support-description" className="gq-support-label">{__("Description", "gq-support")}</label>
          <textarea id="gq-support-description" className="gq-support-field gq-support-description" ref={field} disabled={submission.locked} required placeholder={__("What happened, and what did you expect?", "gq-support")} value={description} onChange={(event) => { edit(); setDescription(event.target.value); setError(""); }} />
          <p className="gq-support-hint">{__("Your draft stays in this panel only while this page and your session stay open. Copy it before you leave or reload; a copy is yours to keep and isn't removed when your support data is erased.", "gq-support")}</p>
          <fieldset className="gq-support-context" disabled={submission.locked}>
            <legend className="gq-support-label">{__("Information included", "gq-support")}</legend>
            <p className="gq-support-hint">{__("Sent with your report through GETQUICK to the project's private GitHub repository, where its collaborators can see it. This site's environment and a pseudonymous reference to you are always included. GitHub can keep copies in issue history and notifications. You won't see this information in My requests.", "gq-support")}</p>
            {context.loading && <p className="gq-support-hint" role="status">{__("Collecting information…", "gq-support")}</p>}
            {context.values.length > 0 && (
              <ul className="gq-support-context-list">
                {context.values.map((item) => (
                  <li key={item.key}>
                    <input id={`gq-support-context-${item.key}`} type="checkbox" checked={item.included} onChange={() => { edit(); context.toggle(item.key); }} />{" "}
                    <label htmlFor={`gq-support-context-${item.key}`}>{contextLabels()[item.key]}: <code>{item.value}</code></label>
                  </li>
                ))}
              </ul>
            )}
            {context.values.some((item) => item.included) && <button type="button" className="gq-support-link" onClick={() => { edit(); context.removeAll(); }}>{__("Remove all", "gq-support")}</button>}
            {(context.failed || context.omitted) && <p className="gq-support-hint" role="status">{__("Some information could not be collected.", "gq-support")}</p>}
          </fieldset>
          {submission.message && !submission.accepted && <p role="status" className="gq-support-message">{submission.message}</p>}
          {submission.checkAgain && <button type="button" disabled={submission.waiting || session.paused} onClick={() => { void submission.send(); }}>{__("Check again", "gq-support")}</button>}
          {error && <p className="gq-support-error" role="alert">{error}</p>}
          {session.blocked && <p className="gq-support-error" role="alert">{session.message}</p>}
          {submission.contact && <Contact />}
          {hasDraft && !session.changed && <button type="button" className="gq-support-link" onClick={() => { void copyDraft(); }}>{__("Copy draft", "gq-support")}</button>}
          {copyState === "copied" && hasDraft && <p className="gq-support-hint">{__("Draft copied.", "gq-support")}</p>}
          {copyState === "manual" && hasDraft && (
            <div>
              <label htmlFor="gq-support-copy" className="gq-support-label">{__("Copying is blocked. Select this text and copy it:", "gq-support")}</label>
              <textarea id="gq-support-copy" className="gq-support-field" ref={manual} readOnly value={draftText} />
            </div>
          )}
          <button type="submit" disabled={session.paused || submission.locked || submission.waiting || context.loading} className="gq-support-submit">
            {submission.retry ? __("Try again", "gq-support") : context.failed ? __("Send without optional information", "gq-support") : __("Send report", "gq-support")}
          </button>
        </form>
      </div>
      <div id="gq-support-requests" role="tabpanel" aria-labelledby="gq-support-requests-tab" hidden={tab !== "requests"}>
        {submission.accepted && (
          <div className="gq-support-outcome">
            <p role="status" className="gq-support-message">{submission.message}</p>
            {hint(submission.phase) && <p className="gq-support-hint">{hint(submission.phase)}</p>}
            {submission.phase === "unknown" && <Contact />}
          </div>
        )}
        <Requests requests={requests} site={session.site} disabled={session.changed} onNewReport={() => setTab("new")} />
      </div>
    </section>
  );
}
