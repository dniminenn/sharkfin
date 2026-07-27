// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import React from "react";
import ReactDOM from "react-dom/client";
import App from "../App";
import ConnectGate from "./ConnectGate";
import Unsupported from "./Unsupported";
import * as backend from "./backend";
import { initColorway } from "@/lib/colorways";
import "../index.css";

// Console escape hatch, the web counterpart of the desktop's dev tools.
declare global {
  interface Window {
    sharkfin: typeof backend;
  }
}
window.sharkfin = backend;

// The colorway is normally applied by the picker inside the app. The
// unsupported screen never mounts that, and without this it would render in
// the default light theme, looking like a different product.
initColorway();

// A browser with no WebHID can never drive a keyboard, so it gets an
// explanation instead of an app whose every control is dead.
const usable = backend.hidAvailable();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {usable ? (
      <>
        <App />
        <ConnectGate />
      </>
    ) : (
      <Unsupported />
    )}
  </React.StrictMode>,
);
