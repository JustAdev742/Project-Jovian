import React from "react";
import ReactDOM from "react-dom/client";
import Main from "./router";
import "./theme.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);

/**
 * Suppress the browser context menu on CHROME only.
 *
 * This used to cancel every right-click in the window. The intent was fine — a right-click menu
 * offering "Reload" and "View source" gives away that a desktop app is a web view — but it also
 * killed Cut/Copy/Paste in every text field and Copy on every log line. On Windows, right-clicking
 * an input to paste is not a nicety, it is how a lot of people type a password.
 *
 * So: inputs, textareas and anything the user is allowed to select keep their native menu; the
 * decorative surfaces around them don't.
 */
window.addEventListener("contextmenu", (e) => {
  const el = e.target as HTMLElement | null;
  if (!el) return;
  if (el.closest("input, textarea, [contenteditable=''], [contenteditable='true'], .selectable")) return;
  // Something is actually selected — the user is going for Copy.
  if (!window.getSelection()?.isCollapsed) return;
  e.preventDefault();
});

root.render(
  <React.StrictMode>
    <Main />
  </React.StrictMode>,
);
