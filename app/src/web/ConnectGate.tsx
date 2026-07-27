// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// The one UI element the browser build adds: WebHID needs a click before a
// page may see the keyboard, so this floats a connect button until the
// origin holds a device permission. After the grant, App's normal scan loop
// takes over.

import { useEffect, useState } from "react";
import { Check, Copy, Usb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { accessProblem, grantedDevices, hidAvailable, requestDevice } from "./backend";

type GateState = "checking" | "unsupported" | "unpaired" | "paired" | "denied";

const UDEV_RULE =
  'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3151", MODE="0660", TAG+="uaccess"';

// One paste: write the rule, reload, apply. `tee` because the redirect would
// run as the user, not as root. Deliberately not a script to download and
// pipe into a shell: everything it does is visible in the line itself.
const UDEV_ONELINER =
  `echo '${UDEV_RULE}' | sudo tee /etc/udev/rules.d/70-sharkfin.rules >/dev/null` +
  " && sudo udevadm control --reload-rules && sudo udevadm trigger";

const isLinux = () =>
  navigator.userAgent.includes("Linux") && !navigator.userAgent.includes("Android");

/** Linux keeps hidraw root-only unless a rule grants the logged-in user access. */
function PermissionHelp() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(UDEV_ONELINER).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="max-w-xl space-y-2 text-sm">
      <p className="font-medium">The keyboard is there, but the browser can't open it.</p>
      {isLinux() ? (
        <>
          <p className="text-muted-foreground">
            On Linux the keyboard's device node belongs to root until a udev rule hands
            it to you. Paste this into a terminal, then unplug the keyboard and plug it
            back in:
          </p>
          <pre className="overflow-x-auto rounded-md border bg-muted/50 p-2 text-xs">
            {UDEV_ONELINER}
          </pre>
          <div className="flex items-center gap-3">
            <Button size="sm" variant="outline" onClick={copy}>
              {copied ? (
                <>
                  <Check className="mr-1 h-3.5 w-3.5" /> Copied
                </>
              ) : (
                <>
                  <Copy className="mr-1 h-3.5 w-3.5" /> Copy the command
                </>
              )}
            </Button>
            <span className="text-xs text-muted-foreground">
              It writes one rule file and reloads udev. Nothing else.
            </span>
          </div>
        </>
      ) : (
        <p className="text-muted-foreground">
          Something else is holding the keyboard open. Close any other keyboard software,
          including a second copy of this page, then unplug it and plug it back in.
        </p>
      )}
    </div>
  );
}

export default function ConnectGate() {
  const [state, setState] = useState<GateState>("checking");

  useEffect(() => {
    if (!hidAvailable()) {
      setState("unsupported");
      return;
    }
    let live = true;
    const check = async () => {
      const devices = await grantedDevices();
      if (!live) return;
      if (accessProblem()) setState("denied");
      else setState(devices.length ? "paired" : "unpaired");
    };
    check();
    const t = setInterval(check, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (state === "paired" || state === "checking") return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-lg">
        {state === "unsupported" ? (
          <span className="text-sm text-muted-foreground">
            This browser can't reach USB devices. Use Chrome, Edge or another Chromium
            browser, or download the desktop app.
          </span>
        ) : state === "denied" ? (
          <PermissionHelp />
        ) : (
          <>
            <span className="text-sm text-muted-foreground">
              Plug the keyboard in with a USB cable, then
            </span>
            <Button size="sm" onClick={() => requestDevice().catch(() => undefined)}>
              <Usb className="mr-1 h-3.5 w-3.5" /> Connect keyboard
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
