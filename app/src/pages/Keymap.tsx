// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, Keyboard } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { deviceLabel } from "@/lib/brands";
import KeyboardView from "@/components/KeyboardView";
import { useBoardLayout, type LayoutKey } from "@/lib/layout-loader";
import { useBoardProfile } from "@/lib/use-profile";
import { layoutBundle, type Inference } from "@/lib/layout-infer";
import { kleToLayout } from "@/lib/kle";
import {
  DISABLED_GLYPH,
  GROUPS,
  PASSTHRU_GLYPH,
  entryLabel,
  usageLabel,
  type Assignable,
} from "@/lib/hid-usages";
import { readKeymap, readFnKeymap, setKey, type ConnectedDevice } from "@/lib/backend";

// Every plain-key usage, for the combo pickers.
const COMBO_KEYS: { label: string; usage: number }[] = GROUPS.flatMap((g) =>
  g.items
    .filter((i) => i.entry[0] === 0 && i.entry[2] !== 0)
    .map((i) => ({ label: i.label, usage: i.entry[2] })),
);

const REPO = "https://github.com/dniminenn/sharkfin";

function sliceEntries(matrix: number[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (let slot = 0; slot < 128; slot++) {
    m.set(slot, matrix.slice(slot * 4, slot * 4 + 4));
  }
  return m;
}

export default function KeymapPage({ device }: { device: ConnectedDevice | null }) {
  const connected = !!device;
  const { profile, count: profileCount, select: selectProfile, switching } =
    useBoardProfile(device);
  const {
    layout,
    resolving,
    pending,
    inference,
    remaining,
    confirm,
    reject,
    recheck,
    tryCustom,
  } = useBoardLayout(device);
  const [verdict, setVerdict] = useState<"right" | "wrong" | null>(null);
  // Kept past rejection: the loader drops its inference then, and a "does
  // not match" report needs the picture that was turned down.
  const [reported, setReported] = useState<Inference | null>(null);
  const [copied, setCopied] = useState(false);
  const [kleText, setKleText] = useState("");
  const [layer, setLayer] = useState<"base" | "fn">("base");
  const [entries, setEntries] = useState<Map<number, number[]> | null>(null);
  const [selected, setSelected] = useState<LayoutKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [combo, setCombo] = useState<{ main: number; extraA: number; extraB: number }>({
    main: 0,
    extraA: 0,
    extraB: 0,
  });

  // Some vendor layouts simply leave keys out: Common68_ZAP68, shared by 33
  // boards, has no Right Ctrl. Those keys exist on the board and answer in
  // its keymap, so they are offered here rather than being unreachable.
  const offPicture = useMemo(() => {
    if (!entries || layout.grid) return [];
    const drawn = new Set(
      layout.keys.filter((k) => k.matrixIndex !== null).map((k) => k.matrixIndex),
    );
    const out: LayoutKey[] = [];
    for (const [slot, entry] of entries) {
      if (drawn.has(slot) || entry.every((b) => b === 0)) continue;
      out.push({
        code: `Slot${slot}`,
        type: "key",
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        text: entryLabel(entry, layer === "fn"),
        matrixIndex: slot,
        matrixEntry: null,
        hidUsage: null,
        consumerUsage: null,
      });
    }
    return out;
  }, [entries, layout, layer]);

  // A selection belongs to the picture it was made on. When the picture
  // changes underneath it, its slot means a different physical key, so
  // writing it would remap something the user never clicked.

  useEffect(() => {
    setSelected(null);
  }, [layout]);

  // Defaults come from the layout; a synthesized grid has none, and the Fn
  // layer's factory state isn't in the layout files either.
  const defaults = useMemo(() => {
    const m = new Map<number, number[]>();
    if (layout.grid || layer === "fn") return m;
    for (const k of layout.keys) {
      if (k.matrixIndex !== null && k.matrixEntry) m.set(k.matrixIndex, k.matrixEntry);
    }
    return m;
  }, [layout, layer]);

  const load = useCallback(async (prof: number, lay: "base" | "fn") => {
    setEntries(null);
    try {
      const matrix = lay === "fn" ? await readFnKeymap(prof) : await readKeymap(prof);
      setEntries(sliceEntries(matrix));
    } catch (e) {
      toast.error(t("Failed to read keymap: {e}", { e: String(e) }));
    }
  }, []);

  useEffect(() => {
    if (connected) load(profile, layer);
    else setEntries(null);
  }, [connected, profile, layer, load]);

  const modified = useMemo(() => {
    const s = new Set<number>();
    if (!entries) return s;
    for (const [slot, def] of defaults) {
      const cur = entries.get(slot);
      if (cur && !def.every((b, i) => b === cur[i])) s.add(slot);
    }
    return s;
  }, [entries, defaults]);

  const assign = async (a: Assignable) => {
    if (!selected || !entries || pending || switching) return;
    const slot = selected.matrixIndex!;
    setBusy(true);
    try {
      await setKey(profile, slot, a.entry, layer === "fn");
      setEntries((prev) => {
        const next = new Map(prev);
        next.set(slot, [...a.entry]);
        return next;
      });
      toast.success(`${selected.text ?? selected.code} → ${a.label}`);
    } catch (e) {
      toast.error(t("Write failed: {e}", { e: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const assignCombo = () => {
    if (!combo.main) return;
    const entry: Assignable["entry"] = [0, combo.extraA, combo.main, combo.extraB];
    const label = [combo.extraA, combo.main, combo.extraB]
      .filter(Boolean)
      .map(usageLabel)
      .join("+");
    return assign({ label, entry });
  };

  const answer = (v: "right" | "wrong") => {
    // "Wrong" pages to the next candidate picture; the verdict only lands
    // once there is nothing left to try.
    setCopied(false);
    if (v === "right") {
      setVerdict("right");
      confirm();
    } else {
      if (remaining === 0) {
        setVerdict("wrong");
        setReported(inference);
      }
      reject();
    }
  };

  const tryKle = async () => {
    try {
      const rate = await tryCustom(kleToLayout(kleText));
      if (rate < 0.9) {
        toast.error(
          rate === 0
            ? t("Could not read the board's keymap to match against.")
            : t("Only {pct}% of the drawn keys match this board.", {
                pct: Math.round(rate * 100),
              }),
        );
      } else {
        setVerdict(null);
        setKleText("");
      }
    } catch (e) {
      toast.error(`${e instanceof Error ? e.message : e}`);
    }
  };

  // A confirmed layout stays contributable in later sessions: inference
  // reruns on every connect until the layout ships with slot data, and a
  // shown, unrejected layout means the stored answer was "looks right".
  const effectiveVerdict = verdict ?? (inference && !pending ? "right" : null);
  const bundleFor = inference ?? reported;

  const copyBundle = async () => {
    if (!device || !bundleFor || !effectiveVerdict) return;
    await navigator.clipboard.writeText(
      layoutBundle(device, bundleFor, effectiveVerdict),
    );
    setCopied(true);
    toast.success(t("Copied. Paste it into the report."));
  };

  const resetKey = async () => {
    if (!selected) return;
    const def = defaults.get(selected.matrixIndex!);
    if (def) await assign({ label: t("default"), entry: def as Assignable["entry"] });
  };

  if (!connected) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {t("Connect your keyboard by USB cable to edit the keymap.")}
      </div>
    );
  }

  const selectedEntry = selected ? entries?.get(selected.matrixIndex!) : undefined;

  const comboSelect = (
    field: "main" | "extraA" | "extraB",
    placeholder: string,
    optional: boolean,
  ) => (
    <Select
      value={combo[field] ? String(combo[field]) : ""}
      onValueChange={(v) => setCombo((c) => ({ ...c, [field]: Number(v) }))}
    >
      <SelectTrigger className="w-32">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {optional && <SelectItem value="0">{t("none")}</SelectItem>}
        {COMBO_KEYS.map((k) => (
          <SelectItem key={`${field}-${k.usage}`} value={String(k.usage)}>
            {k.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("Keys")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Click a key, then pick its new function. Writes are instant.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border p-0.5">
            {(["base", "fn"] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLayer(l)}
                className={cn(
                  "rounded px-3 py-1 text-sm transition-colors",
                  layer === l ? "bg-primary/10 font-medium" : "text-muted-foreground",
                )}
              >
                {l === "base" ? t("Base") : t("Fn layer")}
              </button>
            ))}
          </div>
          <span className="text-sm text-muted-foreground">{t("Profile")}</span>
          <Select
            value={String(profile)}
            onValueChange={(v) => selectProfile(Number(v))}
          >
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: profileCount }, (_, i) => i).map((p) => (
                <SelectItem key={p} value={String(p)}>
                  {p + 1}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {layout.grid && (
        <p className="text-xs text-muted-foreground">
          {t("No layout data for this board yet, so here are its 128 matrix slots as a grid. Everything is still editable; labels come from what the board reports.")}
        </p>
      )}

      {pending && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("Does this match your keyboard?")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              {t("This picture was matched against your board's current keymap. Compare it with the physical keys: same shape, same legends in the same places. Keys stay read-only until you answer.")}
            </p>
            {inference && inference.ambiguous.length > 0 && (
              <p className="text-muted-foreground">
                {t("{n} keys share a factory function with another key, so each pair may be swapped. Check those first.", { n: inference.ambiguous.length })}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => answer("right")}>
                {t("Looks right")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => answer("wrong")}>
                {t("Something is wrong")}
              </Button>
              {remaining > 0 && (
                <span className="text-xs text-muted-foreground">
                  {t("no shows the next closest picture, {remaining} left", { remaining })}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {device && bundleFor && (verdict !== null || !pending) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {effectiveVerdict === "right" ? t("Make it built-in") : t("Help fix it")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              {effectiveVerdict === "right"
                ? t("This layout is matched on your board every time it connects. Paste this bundle into a board report and it ships built in for everyone with this board.")
                : t("You get the slot grid instead. Paste this bundle into a board report so the layout can be fixed for everyone with this board.")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={copyBundle}>
                {copied ? (
                  <Check className="mr-1 h-3.5 w-3.5" />
                ) : (
                  <Copy className="mr-1 h-3.5 w-3.5" />
                )}
                {copied ? t("Copied") : t("Copy bundle")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  openUrl(
                    `${REPO}/issues/new?template=board-report.yml&title=${encodeURIComponent(
                      `[layout] ${deviceLabel(device.spec)}`,
                    )}`,
                  )
                }
              >
                <Keyboard className="mr-1 h-3.5 w-3.5" /> {t("Open a board report")}
              </Button>
              <span className="text-muted-foreground">{t("then paste")}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {connected && layout.grid && !pending && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("Draw your board")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              {t("No stored picture matches this keyboard. If you can draw it on")}{" "}
              <button
                className="underline"
                onClick={() => openUrl("http://www.keyboard-layout-editor.com")}
              >
                keyboard-layout-editor.com
              </button>
              {t(", paste the raw data here and sharkfin will try to match it to your keys.")}
            </p>
            <textarea
              value={kleText}
              onChange={(e) => setKleText(e.target.value)}
              spellCheck={false}
              placeholder='["Esc","Q","W","E", …'
              className="h-24 w-full rounded-md border bg-transparent p-2 font-mono text-xs"
            />
            <Button size="sm" disabled={!kleText.trim()} onClick={tryKle}>
              {t("Try it")}
            </Button>
          </CardContent>
        </Card>
      )}

      {!entries || resolving ? (
        <div className="flex h-64 items-center justify-center text-muted-foreground">
          {resolving ? t("Finding your keyboard…") : t("Reading keymap…")}
        </div>
      ) : (
        <>
          <KeyboardView
            layout={layout}
            selected={selected?.matrixIndex ?? null}
            entries={entries}
            modified={modified}
            labelFor={(k, entry) =>
              entry ? entryLabel(entry, layer === "fn") : (k.text ?? k.code)
            }
            onSelect={setSelected}
          />

          <p className="text-center text-xs text-muted-foreground">
            {defaults.size > 0 && (
              <>
                <span className="mr-1 inline-block h-[0.5em] w-[0.5em] rounded-full bg-(--ring) align-middle" />
                {t("marks a key that differs from this board's factory default.")}{" "}
              </>
            )}
            {layer === "fn"
              ? t("{glyph} means the key falls through to the base layer.", { glyph: PASSTHRU_GLYPH })
              : t("{glyph} means the key does nothing.", { glyph: DISABLED_GLYPH })}
          </p>

          {!pending && (
            <p className="text-center text-xs text-muted-foreground">
              {t("Not your keyboard, or a key missing?")}{" "}
              <button className="underline" onClick={recheck}>
                {t("Check the picture again")}
              </button>
            </p>
          )}

          {offPicture.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t("Keys this picture leaves out")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-muted-foreground">
                  {t("Your board answers for these, but the picture does not draw them. Pick one to remap it. Sending a board report from the Contribute tab is what gets them drawn.")}
                </p>
                <div className="flex flex-wrap gap-1">
                  {offPicture.map((k) => (
                    <button
                      key={k.matrixIndex}
                      onClick={() => setSelected(k)}
                      data-selected={selected?.matrixIndex === k.matrixIndex}
                      className={cn(
                        "rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent",
                        selected?.matrixIndex === k.matrixIndex && "border-(--ring)",
                      )}
                    >
                      {k.text}
                      <span className="ml-1 text-muted-foreground">
                        {t("slot {n}", { n: k.matrixIndex! })}
                      </span>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card className={cn(!selected && "opacity-60")}>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">
                {selected
                  ? layer === "fn"
                    ? t("Assign: {key} (Fn layer)", { key: selected.text ?? selected.code })
                    : t("Assign: {key}", { key: selected.text ?? selected.code })
                  : t("Select a key above")}
                {selected && selectedEntry && (
                  <Badge variant="outline" className="ml-2">
                    {t("now: {label}", { label: entryLabel(selectedEntry, layer === "fn") })}
                  </Badge>
                )}
              </CardTitle>
              {selected && defaults.has(selected.matrixIndex!) && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={resetKey}
                  disabled={busy || pending || switching}
                >
                  {t("Reset to default")}
                </Button>
              )}
            </CardHeader>
            {selected && (
              <CardContent>
                <ScrollArea className="h-56">
                  <div className="space-y-3 pr-3">
                    {GROUPS.map((g) => (
                      <div key={g.name}>
                        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {g.name}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {g.items.map((item) => (
                            <button
                              key={g.name + item.label}
                              disabled={busy || pending || switching}
                              onClick={() => assign(item)}
                              className="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-50"
                            >
                              {item.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                    <div>
                      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {t("Combo: up to three keys on one press")}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {comboSelect("main", t("key"), false)}
                        <span className="text-xs text-muted-foreground">+</span>
                        {comboSelect("extraA", t("second"), true)}
                        <span className="text-xs text-muted-foreground">+</span>
                        {comboSelect("extraB", t("third"), true)}
                        <Button
                          size="sm"
                          disabled={busy || pending || switching || !combo.main}
                          onClick={assignCombo}
                        >
                          {t("Apply combo")}
                        </Button>
                      </div>
                    </div>
                  </div>
                </ScrollArea>
              </CardContent>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
