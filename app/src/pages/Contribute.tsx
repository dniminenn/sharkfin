// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Bug, Check, Copy, FileDown, Keyboard } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { t } from "@/lib/i18n";
import { deviceLabel } from "@/lib/brands";
import { useBoardLayout } from "@/lib/layout-loader";
import { layoutBundle } from "@/lib/layout-infer";
import {
  buildId,
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
  const [version, setVersion] = useState<string | null>(null);
  const [bundle, setBundle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const { pending, inference } = useBoardLayout(device);
  const [layoutCopied, setLayoutCopied] = useState(false);
  // Answered neither as a keyboard nor as a receiver; nothing to report from it.
  const silent = !device && !!unknown && unknown.deviceId === null;
  // A board with an owner's sweep on file has nothing left to report.
  const confirmed = device && !device.readOnly ? device.spec.confirmed : null;

  const copyLayout = async () => {
    if (!device || !inference) return;
    await navigator.clipboard.writeText(layoutBundle(device, inference, "right"));
    setLayoutCopied(true);
    toast.success(t("Copied. Paste it into a board report."));
  };

  useEffect(() => {
    buildId()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  const collect = async () => {
    setBusy(true);
    try {
      setBundle(await contributionBundle(device ? undefined : unknown?.path));
      setCopied(false);
    } catch (e) {
      toast.error(t("Bundle failed: {error}", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!bundle) return;
    await navigator.clipboard.writeText(bundle);
    setCopied(true);
    toast.success(t("Copied. Paste it into the issue."));
  };


  return (
    <div className="mx-auto max-w-3xl space-y-6 p-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t("Contribute")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Reporting a bug, or telling us how your board behaves? Both work the same way: collect a bundle, copy it, paste it into an issue. The bundle is read-only and never writes to the keyboard.")}
        </p>
        {version && (
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            sharkfin {version}
          </p>
        )}
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            {device
              ? deviceLabel(device.spec)
              : unknown
                ? unknown.product || t("Unrecognized keyboard")
                : t("No keyboard connected")}
          </CardTitle>
          {device ? (
            <Badge variant="outline">
              {device.readOnly ? t("read-only") : t("id {id}", { id: device.deviceId })}
            </Badge>
          ) : (
            unknown && (
              <Badge variant="outline">
                {silent ? t("no answer") : t("not in the registry")}
              </Badge>
            )
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {device?.readOnly && (
            <p className="text-sm text-muted-foreground">
              {t("This board stays read-only until its command set is known. A bundle is the first step.")}
            </p>
          )}
          {confirmed && (
            <p className="text-sm text-muted-foreground">
              {t("This board is confirmed on hardware (issue #{issue}, sharkfin {version}). There is nothing to send unless something is wrong; a bug report still wants a bundle.", { issue: confirmed.issue, version: confirmed.version })}
            </p>
          )}
          {!device && unknown && unknown.deviceId !== null && (
            <p className="text-sm text-muted-foreground">
              {t("sharkfin does not know this board yet. A bundle is the first step to adding it.")}
            </p>
          )}
          {silent && (
            <p className="text-sm text-muted-foreground">
              {t("This device did not answer as a keyboard or as a receiver. Connect the keyboard by cable and it will appear here.")}
            </p>
          )}

          {!silent && (
            <ol className="space-y-3 text-sm">
              <li className="flex items-center gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs">
                  1
                </span>
                <Button size="sm" onClick={collect} disabled={busy || (!device && !unknown)}>
                  <FileDown className="mr-1 h-3.5 w-3.5" />
                  {busy ? t("Reading board…") : t("Collect data bundle")}
                </Button>
                {!device && !unknown && (
                  <span className="text-muted-foreground">
                    {t("connect a keyboard")}
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
                  {copied ? t("Copied") : t("Copy")}
                </Button>
              </li>
              <li className="flex flex-wrap items-center gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs">
                  3
                </span>
                {!confirmed && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openUrl(issueUrl(device, unknown, "board-report"))}
                  >
                    <Keyboard className="mr-1 h-3.5 w-3.5" /> {t("Report this board")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => openUrl(issueUrl(device, unknown, "bug"))}
                >
                  <Bug className="mr-1 h-3.5 w-3.5" /> {t("Report a bug")}
                </Button>
                <span className="text-muted-foreground">{t("then paste")}</span>
              </li>
            </ol>
          )}
        </CardContent>
      </Card>

      {device && inference && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">{t("Keyboard picture")}</CardTitle>
            <Badge variant="outline">{pending ? t("unconfirmed") : t("confirmed")}</Badge>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {pending ? (
              <p className="text-muted-foreground">
                {t("The Keys page is asking whether the keyboard picture matches your board. Answer there first; the picture then has its own bundle you can send from here.")}
              </p>
            ) : (
              <>
                <p className="text-muted-foreground">
                  {t("You confirmed the keyboard picture for this board. Send it in and it ships built in for everyone with this board: copy, open a board report, paste.")}
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <Button size="sm" variant="outline" onClick={copyLayout}>
                    {layoutCopied ? (
                      <Check className="mr-1 h-3.5 w-3.5" />
                    ) : (
                      <Copy className="mr-1 h-3.5 w-3.5" />
                    )}
                    {layoutCopied ? t("Copied") : t("Copy picture bundle")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openUrl(issueUrl(device, unknown, "board-report"))}
                  >
                    <Keyboard className="mr-1 h-3.5 w-3.5" /> {t("Report this board")}
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
            <CardTitle className="text-base">{t("Data bundle")}</CardTitle>
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
