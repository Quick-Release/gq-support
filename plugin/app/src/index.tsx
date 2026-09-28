/** @jsxRuntime classic */
/** @jsx createElement */
import { createElement, createRoot } from "@wordpress/element";
import { App } from "./App";
import "./app.css";

type VisibilityListener = (visible: boolean, hasDraft: boolean) => void;

declare global {
  interface Window {
    gqSupportMount: (container: HTMLElement, onVisibilityChange: VisibilityListener) => void;
    gqSupportToggle: () => void;
  }
}

let toggle: (() => void) | undefined;
window.gqSupportMount = (container, onVisibilityChange) => {
  const host = document.createElement("div");
  host.className = "gq-support-app-host";
  container.appendChild(host);
  createRoot(host).render(<App registerToggle={(callback) => { toggle = callback; }} onVisibilityChange={onVisibilityChange} />);
};
window.gqSupportToggle = () => toggle?.();
