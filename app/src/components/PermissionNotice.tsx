// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shown when a keyboard is present but its device node cannot be opened.
// On Linux that is almost always a missing udev rule, and without saying so
// the app just looks broken: the board is plugged in, nothing happens.

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

// Most of these boards are ROYUAN's 3151, but 61 of the 523 in the registry
// ship under a different vendor ID, so matching 3151 alone locks their owners
// out. Keep in step with `packaging/70-sharkfin.rules`.
const UDEV_RULE =
  'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3151|379a|374a|38a9|046a|2ea8|145f", MODE="0660", TAG+="uaccess"';

// One paste: write the rule, reload, apply. `tee` because the redirect would
// run as the user, not as root. Deliberately not a script to download and
// pipe into a shell: everything it does is visible in the line itself.
// Continued across lines so it stays readable in a narrow panel. Pasting it
// still runs as one command, and a visual wrap inserts no newline of its own.
const UDEV_ONELINER = [
  `echo '${UDEV_RULE}' \\`,
  "  | sudo tee /etc/udev/rules.d/70-sharkfin.rules >/dev/null \\",
  "  && sudo udevadm control --reload-rules && sudo udevadm trigger",
].join("\n");

const isLinux = () =>
  navigator.userAgent.includes("Linux") && !navigator.userAgent.includes("Android");

/** Linux keeps hidraw root-only unless a rule grants the logged-in user access. */
export default function PermissionNotice() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(UDEV_ONELINER).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <div className="pointer-events-auto rounded-xl border bg-card px-4 py-3 shadow-lg">
        <div className="max-w-xl space-y-2 text-sm">
          <p className="font-medium">The keyboard is there, but sharkfin can't open it.</p>
          {isLinux() ? (
            <>
              <p className="text-muted-foreground">
                On Linux the keyboard's device node belongs to root until a udev rule hands
                it to you. Paste this into a terminal, then unplug the keyboard and plug it
                back in:
              </p>
              <pre className="whitespace-pre-wrap break-all rounded-md border bg-muted/50 p-2 text-[11px] leading-relaxed">
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
              including a second copy of sharkfin, then unplug it and plug it back in.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
