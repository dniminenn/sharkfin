// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-FileCopyrightText: Shiroki Satsuki <me@shirok1.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shown when a keyboard is present but its device node cannot be opened.
// On Linux that is almost always a missing udev rule, and without saying so
// the app just looks broken: the board is plugged in, nothing happens.

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import {
  requestInputMonitoring,
  openInputMonitoringSettings,
  revealCurrentApp,
  type InputMonitoringStatus,
} from "@/lib/backend";

// Most of these boards are ROYUAN's 3151, but 277 of the 1384 in the registry
// ship under a different vendor ID, so matching 3151 alone locks their owners
// out. Keep in step with `packaging/70-sharkfin.rules`.
const UDEV_RULE =
  'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3151|0461|046a|05ac|0db0|145f|14a5|2ea8|3121|3299|331a|374a|379a|38a9|38ee|391d|3984|39a8|39ab|54ab", MODE="0660", TAG+="uaccess"';

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

export default function PermissionNotice({ inputMonitoring, onRefresh }: {
  inputMonitoring: InputMonitoringStatus | null;
  onRefresh: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runAction = async (action: () => Promise<void>) => {
    setRequesting(true);
    setError(null);
    try {
      await action();
      await onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setRequesting(false);
    }
  };
  const copy = () => {
    navigator.clipboard.writeText(UDEV_ONELINER).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <div className="pointer-events-auto rounded-xl bg-card px-4 py-3 shadow-lg ring-1 ring-foreground/10">
        <div className="flex max-w-xl flex-col gap-2 text-sm">
          <p className="font-medium">{t("The keyboard is there, but sharkfin can't open it.")}</p>
          {inputMonitoring === "unknown" || inputMonitoring === "denied" ? (
            <>
              <p className="text-muted-foreground">
                {t("macOS needs Input Monitoring permission to connect to this keyboard. Enable sharkfin in System Settings → Privacy & Security → Input Monitoring, then quit and reopen sharkfin.")}
              </p>
              <div className="flex flex-wrap gap-2">
                {inputMonitoring === "unknown" && (
                  <Button size="sm" disabled={requesting} onClick={() => runAction(requestInputMonitoring)}>
                    {t("Request input access")}
                  </Button>
                )}
                <Button size="sm" variant={inputMonitoring === "denied" ? "default" : "outline"} disabled={requesting} onClick={() => runAction(openInputMonitoringSettings)}>
                  {t("Open Input Monitoring")}
                </Button>
                <Button size="sm" variant="outline" disabled={requesting} onClick={() => runAction(revealCurrentApp)}>
                  {t("Show sharkfin in Finder")}
                </Button>
              </div>
              <p className="text-muted-foreground">
                {t("If sharkfin is missing from the list, use the + button in Input Monitoring to add the app shown in Finder.")}
              </p>
              {error && <p role="alert" className="text-destructive">{error}</p>}
            </>
          ) : isLinux() ? (
            <>
              <p className="text-muted-foreground">
                {t("On Linux the keyboard's device node belongs to root until a udev rule hands it to you. Paste this into a terminal, then unplug the keyboard and plug it back in:")}
              </p>
              <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 text-[11px] leading-relaxed">
                {UDEV_ONELINER}
              </pre>
              <div className="flex items-center gap-3">
                <Button size="sm" variant="ghost" onClick={copy}>
                  {copied ? (
                    <>
                      <Check className="mr-1 h-3.5 w-3.5" /> {t("Copied")}
                    </>
                  ) : (
                    <>
                      <Copy className="mr-1 h-3.5 w-3.5" /> {t("Copy the command")}
                    </>
                  )}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t("It writes one rule file and reloads udev. Nothing else.")}
                </span>
              </div>
            </>
          ) : (
            <>
              {inputMonitoring === "granted" && (
                <p className="text-muted-foreground">
                  {t("Input Monitoring is enabled. If you just enabled it, quit and reopen sharkfin.")}
                </p>
              )}
              <p className="text-muted-foreground">
                {t("Another app may be holding the keyboard open. Close other keyboard software, then unplug the keyboard and plug it back in.")}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
