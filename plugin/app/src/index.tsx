/** @jsxRuntime classic */
/** @jsx createElement */
import { createElement, createRoot } from "@wordpress/element";
import { App } from "./App";
import "./app.css";

declare global {
  interface Window {
    gqSupportMount: (container: HTMLElement) => void;
    gqSupportOpen: () => void;
  }
}

let open: (() => void) | undefined;
window.gqSupportMount = (container) => {
  const host = document.createElement('div');
  host.className = 'gq-support-app-host';
  container.appendChild(host);
  createRoot(host).render(<App registerOpen={(callback) => { open = callback; }} />);
};
window.gqSupportOpen = () => open?.();
