// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// The plate is the page. One line above it, one line below it; the picker
// opens on the key you click. Anything about the picture itself lives in
// the Picture menu.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, Pencil, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import KeyPicker, { directUsage, rememberRecent, searchAssignables } from "@/components/KeyPicker";
import LayoutEditor from "@/components/LayoutEditor";
import { useBoardLayout, type BoardLayout, type LayoutKey } from "@/lib/layout-loader";
import { useBoardProfile } from "@/lib/use-profile";
import { layoutBundle, type Inference } from "@/lib/layout-infer";
import { fromLayout, type Draft } from "@/lib/layout-draft";
import { DISABLED_GLYPH, PASSTHRU_GLYPH, entryLabel, usageLabel, type Assignable } from "@/lib/hid-usages";
import { readKeymap, readFnKeymap, setKey, type ConnectedDevice } from "@/lib/backend";
import Waiting from "@/components/Waiting";
import { Banner, PageHeader, Segmented } from "@/components/Page";

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
    sweep,
    tryCustom,
    previewCustom,
    nearest,
  } = useBoardLayout(device);
  const [verdict, setVerdict] = useState<"right" | "wrong" | null>(null);
  // Kept past rejection: the loader drops its inference then, and a "does
  // not match" report needs the picture that was turned down.
  const [reported, setReported] = useState<Inference | null>(null);
  const [drawing, setDrawing] = useState(false);
  // Kept while the editor is closed, so a drawing turned down at the
  // confirmation step can be picked up where it was left.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [layer, setLayer] = useState<"base" | "fn">("base");
  const [entries, setEntries] = useState<Map<number, number[]> | null>(null);
  const [selected, setSelected] = useState<LayoutKey | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<number | null>(null);
  const flashTimer = useRef<number | null>(null);

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

  useEffect(() => {
    setQuery("");
  }, [selected]);

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
      rememberRecent(a);
      // The cap itself says the write landed; the picker closes on it.
      setSelected(null);
      setFlash(slot);
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(null), 700);
    } catch (e) {
      toast.error(t("Write failed: {e}", { e: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const answer = (v: "right" | "wrong") => {
    // "Wrong" pages to the next candidate picture; the verdict only lands
    // once there is nothing left to try.
    if (v === "right") {
      setVerdict("right");
      confirm();
      // The one moment to ask. A picture confirmed here is the only way
      // the collection grows, and the page itself stays quiet about it.
      const inf = inference;
      if (inf)
        toast(t("Picture confirmed."), {
          description: t("sharkfin has no telemetry, so it only learns about boards from what owners send in. Send this one in and it ships built in for everyone with this board."),
          duration: 15000,
          action: { label: t("Send it in"), onClick: () => sendIn(inf, "right") },
        });
    } else {
      if (remaining === 0) {
        setVerdict("wrong");
        setReported(inference);
      }
      reject();
    }
  };

  const useDrawing = async (geometry: BoardLayout) => {
    const rate = await tryCustom(geometry);
    if (rate < 0.9) {
      toast.error(
        rate === 0
          ? t("Could not read the board's keymap to match against.")
          : t("Only {pct}% of the drawn keys match this board.", {
              pct: Math.round(rate * 100),
            }),
      );
      return;
    }
    setVerdict(null);
    setDrawing(false);
  };

  const editPicture = () => {
    setDraft(fromLayout(layout));
    setDrawing(true);
  };

  // A confirmed layout stays contributable in later sessions: inference
  // reruns on every connect until the layout ships with slot data, and a
  // shown, unrejected layout means the stored answer was "looks right".
  const effectiveVerdict = verdict ?? (inference && !pending ? "right" : null);
  const bundleFor = inference ?? reported;

  // The report opens first: in a browser the click is what lets a window
  // open, and an await in between would spend it.
  const sendIn = async (inf: Inference, v: "right" | "wrong") => {
    if (!device) return;
    openUrl(
      `${REPO}/issues/new?template=board-report.yml&title=${encodeURIComponent(
        `[layout] ${deviceLabel(device.spec)}`,
      )}`,
    );
    await navigator.clipboard.writeText(layoutBundle(device, inf, v));
    toast.success(t("Bundle copied. Paste it into the report."));
  };

  // On the cap: Enter takes the first match, Escape lets go, and a key that
  // is not a character (F13, PgUp, Delete) assigns itself.
  const onCapKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setSelected(null);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const first = searchAssignables(query)[0];
      if (first) assign(first);
      return;
    }
    const usage = directUsage(e);
    if (usage !== undefined) {
      e.preventDefault();
      assign({ label: usageLabel(usage), entry: [0, 0, usage, 0] });
    }
  };

  const resetKey = async () => {
    if (!selected) return;
    const def = defaults.get(selected.matrixIndex!);
    if (def) await assign({ label: t("default"), entry: def as Assignable["entry"] });
  };

  if (!connected) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {t("Connect your keyboard to edit the keymap.")}
      </div>
    );
  }

  const selectedEntry = selected ? entries?.get(selected.matrixIndex!) : undefined;
  const offSelected = selected && !layout.keys.some((k) => k.matrixIndex === selected.matrixIndex);

  const pictureNote = layout.grid
    ? t("No picture yet, so every key is a numbered slot.")
    : inference?.layoutName === "kle"
      ? t("Your drawing.")
      : inference
        ? t("Picture matched against this board.")
        : t("Built-in picture.");

  const picker = selected && (
    <PopoverContent
      align="center"
      side="bottom"
      sideOffset={10}
      className="w-auto p-3"
      onOpenAutoFocus={(e) => e.preventDefault()}
    >
      <KeyPicker
        name={selected.text ?? selected.code}
        query={query}
        current={selectedEntry}
        fnLayer={layer === "fn"}
        canReset={defaults.has(selected.matrixIndex!)}
        disabled={busy || pending || switching}
        onAssign={assign}
        onReset={resetKey}
      />
    </PopoverContent>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <PageHeader
        title={t("Keys")}
        hint={
          drawing
            ? undefined
            : pending
              ? t("Confirm the picture below before remapping.")
              : t("Click a key to change what it does. Writes are instant.")
        }
      >
        {!drawing && (
          <>
            <Segmented
              value={layer}
              options={[
                ["base", t("Base")],
                ["fn", t("Fn layer")],
              ]}
              onChange={setLayer}
            />
            {profileCount > 1 && (
              <Select value={String(profile)} onValueChange={(v) => selectProfile(Number(v))}>
                <SelectTrigger size="sm" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: profileCount }, (_, i) => i).map((p) => (
                    <SelectItem key={p} value={String(p)}>
                      {t("Profile {n}", { n: p + 1 })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {!pending && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost">
                    {t("Picture")} <ChevronDown className="ml-1 h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">{pictureNote}</div>
                  <DropdownMenuSeparator />
                  {!layout.grid && (
                    <DropdownMenuItem onClick={editPicture}>
                      <Pencil /> {t("Edit the picture")}
                    </DropdownMenuItem>
                  )}
                  {layout.grid && (
                    <DropdownMenuItem onClick={() => setDrawing(true)}>
                      <Pencil /> {draft ? t("Continue drawing") : t("Draw the board")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={sweep}>
                    <RefreshCw /> {t("Try another picture")}
                  </DropdownMenuItem>
                  {device && bundleFor && effectiveVerdict && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => sendIn(bundleFor, effectiveVerdict)}>
                        <Send />{" "}
                        {effectiveVerdict === "right"
                          ? t("Send this picture in")
                          : t("Send what the board reports")}
                      </DropdownMenuItem>
                      <div className="px-2 pb-1.5 text-xs text-muted-foreground">
                        {t("sharkfin has no telemetry, so it only learns about boards from what owners send in.")}
                      </div>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        )}
      </PageHeader>

      {pending && !drawing && (
        <Banner className="motion-safe:slide-in-from-top-1">
          <p className="font-medium">{t("Does this match your keyboard?")}</p>
          <p className="mt-0.5 text-muted-foreground">
            {inference?.layoutName === "kle"
              ? t("Your drawing, matched against the board's keymap. Compare it with the physical keys.")
              : t("Matched against the board's keymap. Same shape, same legends in the same places?")}
            {inference && inference.ambiguous.length > 0 &&
              " " + t("{n} keys share a factory function with another key, so each pair may be swapped. Check those first.", { n: inference.ambiguous.length })}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => answer("right")}>
              {t("Looks right")}
            </Button>
            <Button size="sm" variant="ghost" onClick={editPicture}>
              <Pencil className="mr-1 h-3.5 w-3.5" /> {t("Almost, let me fix it")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => answer("wrong")}>
              {remaining > 0
                ? t("Wrong, show the next one ({n} left)", { n: remaining })
                : t("Wrong, give up on stored pictures")}
            </Button>
          </div>
        </Banner>
      )}

      {layout.grid && !pending && !drawing && (
        <Banner>
          <p className="font-medium">{t("No picture of this keyboard yet")}</p>
          <p className="mt-0.5 text-muted-foreground">
            {t("Every key the board reports is below as a numbered slot, and remapping works as usual. Draw the board to get a real picture: start from a preset or the closest stored one, and each key is checked against your board as you go.")}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => setDrawing(true)}>
              <Pencil className="mr-1 h-3.5 w-3.5" />
              {draft ? t("Continue drawing") : t("Draw the board")}
            </Button>
            {device && bundleFor && (
              <span className="text-xs text-muted-foreground">
                {t("or")}{" "}
                <button
                  className="text-primary underline underline-offset-2"
                  onClick={() => sendIn(bundleFor, effectiveVerdict ?? "wrong")}
                >
                  {t("send what the board reports")}
                </button>{" "}
                {t("and it gets drawn for you.")}
              </span>
            )}
          </div>
        </Banner>
      )}

      {drawing && (
        <LayoutEditor
          title={layout.grid ? t("Draw the board") : t("Edit the picture")}
          draft={draft}
          onChange={setDraft}
          nearest={nearest}
          preview={previewCustom}
          onUse={useDrawing}
          onClose={() => setDrawing(false)}
        />
      )}

      {drawing ? null : !entries || resolving ? (
        <div className="flex h-64 items-center justify-center">
          <Waiting label={resolving ? t("Finding your keyboard…") : t("Reading keymap…")} />
        </div>
      ) : (
        <Popover open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
          <KeyboardView
            layout={layout}
            selected={selected?.matrixIndex ?? null}
            entries={entries}
            modified={modified}
            flash={flash}
            anchor={!offSelected}
            editor={
              selected && !offSelected && !pending
                ? {
                    value: query,
                    placeholder: entryLabel(selectedEntry ?? [0, 0, 0, 0], layer === "fn"),
                    onChange: setQuery,
                    onKeyDown: onCapKey,
                  }
                : undefined
            }
            labelFor={(k, entry) =>
              entry ? entryLabel(entry, layer === "fn") : (k.text ?? k.code)
            }
            onSelect={setSelected}
          />

          <p className="text-center text-xs text-muted-foreground">
            {defaults.size > 0 && (
              <>
                <span className="mr-1 inline-block h-[0.5em] w-[0.5em] rounded-full bg-(--ring) align-middle" />
                {t("changed from factory.")}{" "}
              </>
            )}
            {layer === "fn"
              ? t("{glyph} falls through to the base layer.", { glyph: PASSTHRU_GLYPH })
              : t("{glyph} does nothing.", { glyph: DISABLED_GLYPH })}
          </p>

          {offPicture.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <span className="mr-1">{t("Also on this board, not in the picture:")}</span>
              {offPicture.map((k) => {
                const on = selected?.matrixIndex === k.matrixIndex;
                const chip = (
                  <button
                    key={k.matrixIndex}
                    onClick={() => setSelected(k)}
                    data-on={on}
                    className={cn(
                      "keycap rounded-md px-2 py-1 font-mono text-xs",
                      on && "outline-2 outline-(--ring)",
                    )}
                    style={{ "--key": "var(--key-base)", "--key-fg": "var(--key-legend)" } as React.CSSProperties}
                  >
                    {k.text}
                  </button>
                );
                return on ? (
                  <PopoverAnchor key={k.matrixIndex} asChild>
                    {chip}
                  </PopoverAnchor>
                ) : (
                  chip
                );
              })}
            </div>
          )}

          {picker}
        </Popover>
      )}
    </div>
  );
}
