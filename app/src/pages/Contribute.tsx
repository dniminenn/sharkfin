// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from "react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Bug, Check, Copy, FileDown, Keyboard } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { deviceLabel } from "@/lib/brands";
import { useBoardLayout } from "@/lib/layout-loader";
import { layoutBundle } from "@/lib/layout-infer";
import {
  contributionBundle,
  type ConnectedDevice,
  type DiscoveredUnknown,
} from "@/lib/backend";

const REPO = "https://github.com/dniminenn/sharkfin";

// Both flows land on a template whose first field is the pasted bundle.
function issueUrl(
  device: ConnectedDevice | null,
  unknown: DiscoveredUnknown | null,
  kind: "board-report" | "bug",
) {
  const url = `${REPO}/issues/new?template=${kind}.yml`;
  const name = device ? deviceLabel(device.spec) : unknown?.product;
  if (!name) return url;
  const tag = kind === "bug" ? "bug" : "board";
  return `${url}&title=${encodeURIComponent(`[${tag}] ${name}`)}`;
}

export default function ContributePage({
  device,
  unknown,
}: {
  device: ConnectedDevice | null;
  unknown: DiscoveredUnknown | null;
}) {
  const [bundle, setBundle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const { pending, inference } = useBoardLayout(device);
  const [layoutCopied, setLayoutCopied] = useState(false);

  const copyLayout = async () => {
    if (!device || !inference) return;
    await navigator.clipboard.writeText(layoutBundle(device, inference, "right"));
    setLayoutCopied(true);
    toast.success("Copied. Paste it into a board report.");
  };

  const collect = async () => {
    setBusy(true);
    try {
      setBundle(await contributionBundle(device ? undefined : unknown?.path));
      setCopied(false);
    } catch (e) {
      toast.error(`Bundle failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!bundle) return;
    await navigator.clipboard.writeText(bundle);
    setCopied(true);
    toast.success("Copied. Paste it into the issue.");
  };


  return (
    <div className="mx-auto max-w-3xl space-y-6 p-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Contribute</h1>
        <p className="text-sm text-muted-foreground">
          Reporting a bug, or telling us how your board behaves? Both work the
          same way: collect a bundle, copy it, paste it into an issue. The
          bundle is read-only and never writes to the keyboard.
        </p>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            {device
              ? deviceLabel(device.spec)
              : unknown
                ? unknown.product || "Unrecognized keyboard"
                : "No keyboard connected"}
          </CardTitle>
          {device ? (
            <Badge variant="outline">
              {device.readOnly ? "read-only" : `id ${device.deviceId}`}
            </Badge>
          ) : (
            unknown && <Badge variant="outline">not in the registry</Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {device?.readOnly && (
            <p className="text-sm text-muted-foreground">
              This board stays read-only until its command set is known. A
              bundle is the first step.
            </p>
          )}
          {!device && unknown && (
            <p className="text-sm text-muted-foreground">
              sharkfin does not know this board yet. A bundle is the first
              step to adding it.
            </p>
          )}

          <ol className="space-y-3 text-sm">
            <li className="flex items-center gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs">
                1
              </span>
              <Button size="sm" onClick={collect} disabled={busy || (!device && !unknown)}>
                <FileDown className="mr-1 h-3.5 w-3.5" />
                {busy ? "Reading board…" : "Collect data bundle"}
              </Button>
              {!device && !unknown && (
                <span className="text-muted-foreground">
                  connect a keyboard by USB cable
                </span>
              )}
            </li>
            <li className="flex items-center gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs">
                2
              </span>
              <Button size="sm" variant="outline" onClick={copy} disabled={!bundle}>
                {copied ? (
                  <Check className="mr-1 h-3.5 w-3.5" />
                ) : (
                  <Copy className="mr-1 h-3.5 w-3.5" />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
            </li>
            <li className="flex flex-wrap items-center gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs">
                3
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openUrl(issueUrl(device, unknown, "board-report"))}
              >
                <Keyboard className="mr-1 h-3.5 w-3.5" /> Report this board
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openUrl(issueUrl(device, unknown, "bug"))}
              >
                <Bug className="mr-1 h-3.5 w-3.5" /> Report a bug
              </Button>
              <span className="text-muted-foreground">then paste</span>
            </li>
          </ol>
        </CardContent>
      </Card>

      {device && inference && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Keyboard picture</CardTitle>
            <Badge variant="outline">{pending ? "unconfirmed" : "confirmed"}</Badge>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {pending ? (
              <p className="text-muted-foreground">
                The Keys page is asking whether the keyboard picture matches
                your board. Answer there first; the picture then has its own
                bundle you can send from here.
              </p>
            ) : (
              <>
                <p className="text-muted-foreground">
                  You confirmed the keyboard picture for this board. Send it
                  in and it ships built in for everyone with this board:
                  copy, open a board report, paste.
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <Button size="sm" variant="outline" onClick={copyLayout}>
                    {layoutCopied ? (
                      <Check className="mr-1 h-3.5 w-3.5" />
                    ) : (
                      <Copy className="mr-1 h-3.5 w-3.5" />
                    )}
                    {layoutCopied ? "Copied" : "Copy picture bundle"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openUrl(issueUrl(device, unknown, "board-report"))}
                  >
                    <Keyboard className="mr-1 h-3.5 w-3.5" /> Report this board
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {bundle && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Data bundle</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-64 rounded-md border bg-muted/30">
              <pre className="p-3 font-mono text-xs leading-relaxed">{bundle}</pre>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
