// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Bug, Check, Copy, FileDown, Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PageHeader, Section } from "@/components/Page";
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
  const { pending, inference, rejected } = useBoardLayout(device);
  // Answered neither as a keyboard nor as a receiver; nothing to report from it.
  const silent = !device && !!unknown && unknown.deviceId === null;
  // A registered board drawn from its built-in picture has nothing left
  // to report. An inference means the picture was matched at connect or
  // the owner replaced the built-in one; a rejection means none fit.
  // Either is what a report carries.
  const wanted =
    !device || device.spec.unregistered || device.readOnly || !!inference || !!rejected;

  useEffect(() => {
    buildId()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  const collect = async () => {
    setBusy(true);
    try {
      let text = await contributionBundle(device ? undefined : unknown?.path);
      // One paste carries everything: the picture the match found and the
      // owner's answer ride inside the same fence as the sweep.
      const picture =
        device && inference
          ? layoutBundle(device, inference, pending ? null : "right")
          : device && rejected
            ? layoutBundle(device, rejected, "wrong")
            : null;
      if (picture) {
        text = text.replace(/```\s*$/, "") + "\n" + picture.replace(/^```\n/, "");
      }
      setBundle(text);
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


  const status = device
    ? device.spec.unregistered
      ? t("not in the registry")
      : device.readOnly
        ? t("read-only")
        : t("id {id}", { id: device.deviceId })
    : unknown
      ? silent
        ? t("no answer")
        : t("not in the registry")
      : null;

  const step = (n: number) => (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs">
      {n}
    </span>
  );

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <PageHeader
        title={t("Contribute")}
        hint={
          <>
            {t("Reporting a bug, or telling us how your board behaves? Both work the same way: collect a bundle, copy it, paste it into an issue. The bundle is read-only and never writes to the keyboard.")}
            {version && <span className="ml-2 font-mono text-xs">sharkfin {version}</span>}
          </>
        }
      />

      <Section
        title={
          device
            ? deviceLabel(device.spec)
            : unknown
              ? unknown.product || t("Unrecognized keyboard")
              : t("No keyboard connected")
        }
        actions={status && <span className="text-sm text-muted-foreground">{status}</span>}
      >
        {device?.spec.unregistered ? (
          <p className="text-sm text-muted-foreground">
            {t("sharkfin does not know this board yet. It answers like a {family} board, so it can be used. A bundle adds it to the list.", { family: device.spec.family ?? "" })}
          </p>
        ) : (
          device?.readOnly && (
            <p className="text-sm text-muted-foreground">
              {t("This board stays read-only until its command set is known. A bundle is the first step.")}
            </p>
          )
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
              {step(1)}
              <Button size="sm" onClick={collect} disabled={busy || (!device && !unknown)}>
                <FileDown className="mr-1 h-3.5 w-3.5" />
                {busy ? t("Reading board…") : t("Collect data bundle")}
              </Button>
              {!device && !unknown && (
                <span className="text-muted-foreground">{t("connect a keyboard")}</span>
              )}
            </li>
            <li className="flex items-center gap-3">
              {step(2)}
              <Button size="sm" variant="ghost" onClick={copy} disabled={!bundle}>
                {copied ? (
                  <Check className="mr-1 h-3.5 w-3.5" />
                ) : (
                  <Copy className="mr-1 h-3.5 w-3.5" />
                )}
                {copied ? t("Copied") : t("Copy")}
              </Button>
            </li>
            <li className="flex flex-wrap items-center gap-3">
              {step(3)}
              {wanted && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openUrl(issueUrl(device, unknown, "board-report"))}
                >
                  <Keyboard className="mr-1 h-3.5 w-3.5" /> {t("Report this board")}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openUrl(issueUrl(device, unknown, "bug"))}
              >
                <Bug className="mr-1 h-3.5 w-3.5" /> {t("Report a bug")}
              </Button>
              <span className="text-muted-foreground">{t("then paste")}</span>
            </li>
          </ol>
        )}
      </Section>

      {bundle && (
        <Section title={t("Data bundle")}>
          <ScrollArea className="h-64 rounded-xl bg-muted/40">
            <pre className="p-3 font-mono text-xs leading-relaxed">{bundle}</pre>
          </ScrollArea>
        </Section>
      )}
    </div>
  );
}
