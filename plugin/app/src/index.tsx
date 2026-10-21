/** @jsxRuntime classic */
/** @jsx createElement */
import { createElement, createRoot } from "@wordpress/element";
import { App } from "./App";
import { readableOnWhite } from "./accent";
import "./app.css";

type VisibilityListener = (visible: boolean, hasDraft: boolean) => void;
type Root = ReturnType<typeof createRoot>;

declare global {
  interface Window {
    gqSupportMount: (container: HTMLElement, onVisibilityChange: VisibilityListener) => void;
    gqSupportToggle: () => void;
  }
}

let toggle: (() => void) | undefined;
let render: (() => void) | undefined;
let app: { root: Root; host: HTMLElement } | undefined;

window.gqSupportMount = (container, onVisibilityChange) => {
  render = () => {
    const host = document.createElement("div");
    host.className = "gq-support-app-host";
    container.appendChild(host);
    // Core's scheme accent as resolved here, made readable on the panel.
    host.style.color = "var(--wp-admin-theme-color, #135e96)";
    host.style.setProperty("--gq-support-accent", readableOnWhite(getComputedStyle(host).color));
    host.style.color = "";
    const root = createRoot(host);
    app = { root, host };
    root.render(<App registerToggle={(callback) => { toggle = callback; }} onVisibilityChange={onVisibilityChange} />);
  };
  render();
  // Leaving the page drops the draft, intent, request list and timers at once, open or closed, so a
  // back/forward cache return cannot show them. Unmounting is synchronous; the next open starts afresh.
  window.addEventListener("pagehide", () => {
    if (!app) return;
    app.root.unmount();
    app.host.remove();
    app = undefined;
    toggle = undefined;
    onVisibilityChange(false, false);
  });
};
window.gqSupportToggle = () => (app ? toggle?.() : render?.());
