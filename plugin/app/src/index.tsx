/** @jsxRuntime classic */
/** @jsx createElement */
import { createElement, createRoot, StrictMode } from "@wordpress/element";
import { App } from "./App";
import "./app.css";

const container = document.getElementById("gq-support-root");

if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
