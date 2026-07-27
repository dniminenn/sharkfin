// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shown instead of the app when the browser cannot reach USB devices at all.
// Rendering the real UI with a footnote would be worse than useless: every
// control would look live and none of them could ever work.

import { useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import SharkfinLogo from "@/components/SharkfinLogo";

const RELEASES = "https://github.com/dniminenn/sharkfin/releases";

type Reason =
  | { kind: "insecure" }
  | { kind: "mobile" }
  | { kind: "firefox" }
  | { kind: "safari" }
  | { kind: "unknown" };

export function whyUnsupported(): Reason {
  const ua = navigator.userAgent;
  if (!window.isSecureContext) return { kind: "insecure" };
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return { kind: "mobile" };
  if (/Firefox\//.test(ua)) return { kind: "firefox" };
  if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua)) return { kind: "safari" };
  return { kind: "unknown" };
}

function explain(r: Reason): { headline: string; detail: string } {
  switch (r.kind) {
    case "insecure":
      return {
        headline: "This page has to be served over HTTPS",
        detail:
          "Browsers only let a page reach a USB device from a secure origin. " +
          "Open https://app.getsharkfin.com instead.",
      };
    case "mobile":
      return {
        headline: "This needs a computer",
        detail:
          "Phones and tablets cannot hand a USB device to a web page, whatever " +
          "browser they run. Open this on a desktop or laptop with the keyboard " +
          "plugged in, or use the desktop app.",
      };
    case "firefox":
      return {
        headline: "Firefox cannot talk to your keyboard",
        detail:
          "Configuring the board needs WebHID, which Firefox does not implement " +
          "and has said it does not intend to. Nothing on this page will work " +
          "here. Use a Chromium browser, or the desktop app, which has no such " +
          "limitation.",
      };
    case "safari":
      return {
        headline: "Safari cannot talk to your keyboard",
        detail:
          "Configuring the board needs WebHID, which Safari does not implement. " +
          "Use a Chromium browser, or the desktop app, which runs natively on " +
          "macOS.",
      };
    default:
      return {
        headline: "This browser cannot talk to your keyboard",
        detail:
          "Configuring the board needs WebHID, which this browser does not " +
          "provide. Chrome, Edge, Brave, Opera and other Chromium browsers do, " +
          "and the desktop app works everywhere.",
      };
  }
}

export default function Unsupported() {
  const reason = whyUnsupported();
  const { headline, detail } = explain(reason);
  const [copied, setCopied] = useState(false);

  const copyLink = () => {
    navigator.clipboard
      .writeText(window.location.href)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => undefined);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <main className="w-full max-w-xl space-y-6">
        <div className="flex items-center gap-3">
          <span className="text-primary">
            <SharkfinLogo size={32} />
          </span>
          <span className="font-mono text-xl font-bold">sharkfin</span>
        </div>

        <div className="space-y-3">
          <h1 className="font-mono text-2xl font-bold tracking-tight">{headline}</h1>
          <p className="text-muted-foreground">{detail}</p>
        </div>

        <div className="flex flex-wrap gap-3">
          {reason.kind !== "mobile" && (
            <Button variant="outline" onClick={copyLink}>
              {copied ? (
                <>
                  <Check className="mr-1 h-4 w-4" /> Link copied
                </>
              ) : (
                <>
                  <Copy className="mr-1 h-4 w-4" /> Copy this link for Chrome
                </>
              )}
            </Button>
          )}
          <Button asChild>
            <a href={RELEASES}>
              <Download className="mr-1 h-4 w-4" /> Download the desktop app
            </a>
          </Button>
        </div>

        <p className="text-sm text-muted-foreground">
          The desktop app is the same software for Windows, macOS and Linux, and does
          not depend on the browser at all.
        </p>
      </main>
    </div>
  );
}
