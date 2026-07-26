import React from "react";
import ReactDOM from "react-dom/client";
import Main from "./router";
import "./theme.css"; 

const root = ReactDOM.createRoot(document.getElementById("root")!);
window.addEventListener("contextmenu", (e) => e.preventDefault());

root.render(
  <React.StrictMode>
    <Main />
  </React.StrictMode>
);
 