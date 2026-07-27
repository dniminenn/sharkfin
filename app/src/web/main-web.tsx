// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import React from "react";
import ReactDOM from "react-dom/client";
import App from "../App";
import ConnectGate from "./ConnectGate";
import * as backend from "./backend";
import "../index.css";

// Console escape hatch, the web counterpart of the desktop's dev tools.
declare global {
  interface Window {
    sharkfin: typeof backend;
  }
}
window.sharkfin = backend;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <ConnectGate />
  </React.StrictMode>,
);
