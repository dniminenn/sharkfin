// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import React from "react";
import ReactDOM from "react-dom/client";
import App from "../App";
import ConnectGate from "./ConnectGate";
import Unsupported from "./Unsupported";
import * as backend from "./backend";
import { initColorway } from "@/lib/colorways";
import { toast } from "sonner";
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

// The service worker precaches the build, so the page loads with no network
// and Chrome offers to install it as an app. A new build is never activated
// mid-session, because it would swap assets under a running page: it waits
// for the reload the toast offers, and controllerchange fires only then.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  const offerUpdate = (sw: ServiceWorker) => {
    toast("A new version is ready.", {
      duration: Infinity,
      action: {
        label: "Reload",
        onClick: () => sw.postMessage("skip-waiting"),
      },
    });
  };
  navigator.serviceWorker.register("/sw.js").then((reg) => {
    if (reg.waiting) offerUpdate(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      sw?.addEventListener("statechange", () => {
        if (sw.state === "installed" && navigator.serviceWorker.controller) {
          offerUpdate(sw);
        }
      });
    });
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    window.location.reload();
  });
}

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
