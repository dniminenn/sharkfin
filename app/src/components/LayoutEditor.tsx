// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Draw the board on the Keys page. Every edit is matched against the
// connected board's keymap: a key whose label the board does not have
// dims, and the keys the board has that the drawing does not are listed to
// add. The result goes through the same confirmation as any other picture.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Minus, Plus, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { BoardLayout } from "@/lib/layout-loader";
import type { Inference } from "@/lib/layout-infer";
import { entryLabel } from "@/lib/hid-usages";
import { FN_ENTRY, kleToLayout } from "@/lib/kle";
import {
  DRAWABLE,
  KNOB_PRESSES,
  KNOB_SIZE,
  PRESETS,
  STEP,
  VOL_DOWN,
  VOL_UP,
  capLegend,
  extent,
  fromLayout,
  legend,
  placeNew,
  preset,
  toLayout,
  type Draft,
  type DraftKey,
  type DraftUsage,
  type PresetSize,
} from "@/lib/layout-draft";

interface Props {
  draft: Draft | null;
  onChange: (draft: Draft | null) => void;
  nearest: Inference | null;
  preview: (layout: BoardLayout) => Promise<Inference | null>;
  onUse: (layout: BoardLayout) => Promise<void>;
  onClose: () => void;
}

type Selection = { kind: "key"; id: number } | { kind: "knob" } | null;
type Score = { matched: number; total: number; f1: number } | null;

/** Match rate a drawing needs before it is offered to the board. Mirrors
 *  the loader's bar. */
const BAR = 0.9;
/** The gap between caps, in units, as the layout files draw it. */
const CAP_GAP = 6 / 46;

function isFn(entry: number[]) {
  return entry[0] === FN_ENTRY[0] && entry[1] === FN_ENTRY[1] && entry[2] === 0;
}

/** A board entry as something a key can be labelled with, or null. */
function drawableUsage(entry: number[]): DraftUsage | null {
  if (isFn(entry)) return "fn";
  if (entry[0] === 0 && entry[1] === 0 && entry[3] === 0 && entry[2] !== 0) return entry[2];
  return null;
}

const same = (a: number[], b: number[]) => a.every((v, i) => v === b[i]);

/** A board entry the knob accounts for: a rotation, or one of its presses. */
function knobPart(entry: number[]): "turn" | number[] | null {
  if (same(entry, VOL_DOWN) || same(entry, VOL_UP)) return "turn";
  const press = KNOB_PRESSES.find((p) => same(entry, p.entry));
  return press ? press.entry : null;
}

/** A stored picture in the owner's terms: its size and whether it has a
 *  knob. The file's name means nothing to them. */
function describe(layout: BoardLayout): string {
  const keys = layout.keys.filter((k) => k.type !== "knob").length;
  const knob = layout.keys.some((k) => k.type === "knob");
  return knob ? t("{n} keys and a knob", { n: keys }) : t("{n} keys", { n: keys });
}

const fmt = (u: number) => `${u}u`;

export default function LayoutEditor({
  draft,
  onChange,
  nearest,
  preview,
  onUse,
  onClose,
}: Props) {
  const [selected, setSelected] = useState<Selection>(null);
  const [history, setHistory] = useState<Draft[]>([]);
  const [inference, setInference] = useState<Inference | null>(null);
  const [checked, setChecked] = useState(false);
  const [iso, setIso] = useState(false);
  const [knob, setKnob] = useState(false);
  const [scores, setScores] = useState<Partial<Record<PresetSize, Score>>>({});
  const [kleText, setKleText] = useState("");
  const [pasting, setPasting] = useState(false);
  const [busy, setBusy] = useState(false);
  const plateRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    target: Selection;
    before: Draft;
    startX: number;
    startY: number;
    ox: number;
    oy: number;
    pxPerUnit: number;
    moved: boolean;
  } | null>(null);

  // An edit the history can take back. Drags commit once, on release.
  // Starting over and starting from a preset are edits too: the drawing
  // they replace stays one Undo away.
  const apply = useCallback(
    (next: Draft | null) => {
      if (draft) setHistory((h) => [...h.slice(-99), draft]);
      onChange(next);
    },
    [draft, onChange],
  );

  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      onChange(h[h.length - 1]);
      return h.slice(0, -1);
    });
  }, [onChange]);

  const start = (next: Draft | null) => {
    setSelected(null);
    apply(next);
  };

  const loadKle = () => {
    try {
      start(fromLayout(kleToLayout(kleText)));
      setKleText("");
      setPasting(false);
    } catch (e) {
      toast.error(`${e instanceof Error ? e.message : e}`);
    }
  };

  // Every change is scored against the board. The keymap is read once and
  // cached by the loader, so this is cheap enough to run on each edit.
  useEffect(() => {
    if (!draft) return;
    let live = true;
    preview(toLayout(draft)).then((inf) => {
      if (!live) return;
      setInference(inf);
      setChecked(true);
    });
    return () => {
      live = false;
    };
  }, [draft, preview]);

  // The start screen scores every preset the same way, so the owner picks
  // the one that fits instead of guessing from a name.
  useEffect(() => {
    if (draft) return;
    let live = true;
    (async () => {
      const next: Partial<Record<PresetSize, Score>> = {};
      for (const { size } of PRESETS) {
        const inf = await preview(toLayout(preset(size, { iso, knob })));
        if (!live) return;
        next[size] = inf ? { matched: inf.matched, total: inf.total, f1: inf.f1 } : null;
      }
      setScores(next);
    })();
    return () => {
      live = false;
    };
  }, [draft, iso, knob, preview]);

  // Ranked by the symmetric score, not the match rate: a 65% is a subset
  // of every larger board and would score a perfect rate on all of them.
  const bestPreset = useMemo(() => {
    let best: PresetSize | null = null;
    let f1 = 0;
    for (const { size } of PRESETS) {
      const s = scores[size];
      if (s && s.f1 > f1) {
        f1 = s.f1;
        best = size;
      }
    }
    return best;
  }, [scores]);

  const size = useMemo(() => {
    if (!draft) return { width: 1, height: 1 };
    const e = extent(draft);
    return { width: e.width + STEP, height: e.height + STEP };
  }, [draft]);

  // Which drawn keys found a slot. toLayout keeps draft order, so the
  // inferred copy lines up with the draft index by index.
  const matched = useMemo(() => {
    const s = new Set<number>();
    if (!draft || !inference) return s;
    draft.keys.forEach((k, i) => {
      if (inference.layout.keys[i]?.matrixIndex !== null) s.add(k.id);
    });
    return s;
  }, [draft, inference]);

  // Entries the board reports that no drawn key claimed: what is left to
  // draw, or the wrong label on a key that is drawn.
  const missing = useMemo(() => {
    if (!inference) return [];
    const claimed = new Set(
      inference.layout.keys.map((k) => k.matrixIndex).filter((s) => s !== null),
    );
    const out: { label: string; usage: DraftUsage | null; knob: "turn" | number[] | null }[] = [];
    const seen = new Set<string>();
    const m = inference.matrix;
    for (let s = 0; s * 4 + 3 < m.length; s++) {
      if (claimed.has(s)) continue;
      const entry = m.slice(s * 4, s * 4 + 4);
      if (entry.every((b) => b === 0)) continue;
      const label = entryLabel(entry);
      if (seen.has(label)) continue;
      seen.add(label);
      out.push({ label, usage: drawableUsage(entry), knob: knobPart(entry) });
    }
    return out;
  }, [inference]);

  const used = useMemo(() => {
    const m = new Map<DraftUsage, number>();
    for (const k of draft?.keys ?? []) if (k.usage !== null) m.set(k.usage, k.id);
    return m;
  }, [draft]);

  const selectedKey =
    draft && selected?.kind === "key"
      ? (draft.keys.find((k) => k.id === selected.id) ?? null)
      : null;

  const updateKey = (id: number, patch: Partial<DraftKey>) => {
    if (!draft) return;
    apply({ ...draft, keys: draft.keys.map((k) => (k.id === id ? { ...k, ...patch } : k)) });
  };

  const label = (usage: DraftUsage | null) => {
    if (!draft) return;
    if (selectedKey) {
      updateKey(selectedKey.id, { usage, note: undefined });
      return;
    }
    const k = { ...placeNew(draft, null), usage };
    apply({ ...draft, keys: [...draft.keys, k] });
    setSelected({ kind: "key", id: k.id });
    toast(
      t("{label} added at the end of the bottom row. Drag it into place. To fix a dimmed key instead, click that key first.", {
        label: legend(usage),
      }),
    );
  };

  const addKey = () => {
    if (!draft) return;
    const k = placeNew(draft, selectedKey);
    apply({ ...draft, keys: [...draft.keys, k] });
    setSelected({ kind: "key", id: k.id });
  };

  const remove = () => {
    if (!draft || !selected) return;
    if (selected.kind === "knob") apply({ ...draft, knob: null });
    else apply({ ...draft, keys: draft.keys.filter((k) => k.id !== selected.id) });
    setSelected(null);
  };

  const addKnob = (press = draft?.knob?.press ?? KNOB_PRESSES[0].entry) => {
    if (!draft) return;
    const e = extent(draft);
    const at = draft.knob ?? { x: e.width + STEP, y: 0 };
    apply({ ...draft, knob: { x: at.x, y: at.y, press } });
    setSelected({ kind: "knob" });
  };

  const nudge = (dx: number, dy: number) => {
    if (!draft || !selected) return;
    if (selected.kind === "knob" && draft.knob) {
      const k = draft.knob;
      apply({ ...draft, knob: { ...k, x: Math.max(0, k.x + dx), y: Math.max(0, k.y + dy) } });
    } else if (selectedKey) {
      updateKey(selectedKey.id, {
        x: Math.max(0, selectedKey.x + dx),
        y: Math.max(0, selectedKey.y + dy),
      });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
      return;
    }
    if (!selected) return;
    const step = e.shiftKey ? 1 : STEP;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (moves[e.key]) {
      e.preventDefault();
      nudge(...moves[e.key]);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove();
    } else if (e.key === "Escape") {
      setSelected(null);
    }
  };

  // Dragging moves a key on the quarter-unit grid. The click that starts
  // it also selects, so a plain click is a drag that never moved. The drag
  // record owns its target: the selection state may not have re-rendered
  // by the first move.
  const onPointerDown = (e: React.PointerEvent, target: Selection) => {
    if (!draft || !target || e.button !== 0) return;
    e.preventDefault();
    setSelected(target);
    const rect = plateRef.current?.getBoundingClientRect();
    if (!rect) return;
    const at =
      target.kind === "knob" ? draft.knob : draft.keys.find((k) => k.id === target.id);
    if (!at) return;
    dragRef.current = {
      target,
      before: draft,
      startX: e.clientX,
      startY: e.clientY,
      ox: at.x,
      oy: at.y,
      pxPerUnit: rect.width / size.width,
      moved: false,
    };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // A pointer that cannot be captured still drags while it stays over
      // the key.
    }
    plateRef.current?.focus();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !draft || !d.target) return;
    const snap = (v: number) => Math.round(v / STEP) * STEP;
    const x = Math.max(0, snap(d.ox + (e.clientX - d.startX) / d.pxPerUnit));
    const y = Math.max(0, snap(d.oy + (e.clientY - d.startY) / d.pxPerUnit));
    if (d.target.kind === "knob") {
      if (!draft.knob || (draft.knob.x === x && draft.knob.y === y)) return;
      d.moved = true;
      onChange({ ...draft, knob: { ...draft.knob, x, y } });
    } else {
      const id = d.target.id;
      const k = draft.keys.find((k) => k.id === id);
      if (!k || (k.x === x && k.y === y)) return;
      d.moved = true;
      onChange({
        ...draft,
        keys: draft.keys.map((kk) => (kk.id === id ? { ...kk, x, y } : kk)),
      });
    }
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.moved) setHistory((h) => [...h.slice(-99), d.before]);
  };

  const use = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await onUse(toLayout(draft));
    } finally {
      setBusy(false);
    }
  };

  const labelled = draft?.keys.filter((k) => k.usage !== null).length ?? 0;
  const unlabelled = (draft?.keys.length ?? 0) - labelled;
  const wrong = labelled - matched.size;
  const rate = inference?.matchRate ?? 0;

  if (!draft) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("Draw your board")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            {t("No stored picture matches this keyboard. Pick the closest start below. Each key then shows whether your board has it, and anything the board has that is not drawn is listed to add.")}
          </p>
          {history.length > 0 && (
            <Button size="sm" onClick={undo}>
              <Undo2 className="mr-1 h-3.5 w-3.5" /> {t("Back to the drawing")}
            </Button>
          )}
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={iso} onChange={(e) => setIso(e.target.checked)} />
              {t("ISO layout")}
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={knob} onChange={(e) => setKnob(e.target.checked)} />
              {t("Has a knob")}
            </label>
          </div>
          {nearest && (
            <div className="space-y-1">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("Closest stored picture")}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => start(fromLayout(nearest.layout))}>
                  {t("Start from it")}
                </Button>
                <span className="text-muted-foreground">
                  {t("{what}, {matched} of {total} keys match your board. Fix what differs.", {
                    what: describe(nearest.layout),
                    matched: nearest.matched,
                    total: nearest.total,
                  })}
                </span>
              </div>
            </div>
          )}
          <div className="space-y-1">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("Blank preset")}
            </div>
            <div className="flex flex-wrap items-stretch gap-2">
              {PRESETS.map((p) => {
                const s = scores[p.size];
                const best = bestPreset === p.size;
                return (
                  <button
                    key={p.size}
                    type="button"
                    onClick={() => start(preset(p.size, { iso, knob }))}
                    className={cn(
                      "flex min-w-20 flex-col items-center rounded-md border px-3 py-1.5 transition-colors hover:bg-accent",
                      best && "border-(--ring) bg-primary/10",
                    )}
                  >
                    <span className="font-medium">{p.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {s
                        ? t("{matched} of {total} match", { matched: s.matched, total: s.total })
                        : t("{n} keys", { n: preset(p.size, { iso, knob }).keys.length })}
                    </span>
                  </button>
                );
              })}
            </div>
            {bestPreset && (
              <p className="text-xs text-muted-foreground">
                {t("The highlighted one fits your board best.")}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <button className="text-xs text-muted-foreground underline" onClick={() => setPasting((v) => !v)}>
              {t("Paste a keyboard-layout-editor.com drawing instead")}
            </button>
            {pasting && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {t("Copy the raw data from")}{" "}
                  <button
                    className="underline"
                    onClick={() => openUrl("http://www.keyboard-layout-editor.com")}
                  >
                    keyboard-layout-editor.com
                  </button>
                  {t(" and paste it here. The drawing opens in the editor.")}
                </p>
                <textarea
                  value={kleText}
                  onChange={(e) => setKleText(e.target.value)}
                  spellCheck={false}
                  placeholder='["Esc","Q","W","E", …'
                  className="h-24 w-full rounded-md border bg-transparent p-2 font-mono text-xs"
                />
                <Button size="sm" disabled={!kleText.trim()} onClick={loadKle}>
                  {t("Open in the editor")}
                </Button>
              </div>
            )}
          </div>
          <div>
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t("Close")}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const cq = (u: number) => `${(u / size.width) * 100}cqw`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{t("Draw your board")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("Click a key to label or resize it, drag to move. Arrow keys nudge, Delete removes.")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={undo} disabled={!history.length}>
            <Undo2 className="mr-1 h-3.5 w-3.5" /> {t("Undo")}
          </Button>
          <Button size="sm" variant="outline" onClick={addKey}>
            <Plus className="mr-1 h-3.5 w-3.5" /> {t("Add key")}
          </Button>
          {!draft.knob && (
            <Button size="sm" variant="outline" onClick={() => addKnob()}>
              <Plus className="mr-1 h-3.5 w-3.5" /> {t("Add knob")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => start(null)}>
            {t("Start over")}
          </Button>
        </div>
      </div>

      <div className="w-full">
        <div className="keycap-plate mx-auto max-w-[920px] rounded-2xl p-[1.6%]">
          <div
            ref={plateRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) setSelected(null);
            }}
            className="relative outline-none"
            style={{
              aspectRatio: `${size.width} / ${size.height}`,
              containerType: "inline-size",
              touchAction: "none",
            }}
          >
            {draft.keys.map((k) => {
              const dead = checked && k.usage !== null && !matched.has(k.id);
              const isSel = selected?.kind === "key" && selected.id === k.id;
              return (
                <button
                  key={k.id}
                  type="button"
                  onPointerDown={(e) => onPointerDown(e, { kind: "key", id: k.id })}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                  data-selected={isSel}
                  title={
                    k.usage === null
                      ? k.note
                        ? t("{note}: no label yet", { note: k.note })
                        : t("No label yet")
                      : dead
                        ? t("{key}: your board has no key with this label", { key: legend(k.usage) })
                        : legend(k.usage)
                  }
                  className={cn(
                    "keycap absolute flex cursor-grab items-center justify-center overflow-hidden rounded-[8%] font-medium leading-none tracking-tight active:cursor-grabbing",
                    dead && "opacity-40",
                    k.usage === null && "border-dashed",
                    isSel && "z-10",
                  )}
                  style={{
                    "--key": k.usage === null ? "var(--key-plate)" : "var(--key-base)",
                    "--key-fg": "var(--key-legend)",
                    left: cq(k.x),
                    top: cq(k.y),
                    width: cq(k.w - CAP_GAP),
                    height: cq(k.h - CAP_GAP),
                    fontSize: cq(0.28),
                  } as React.CSSProperties}
                >
                  {k.usage === null ? (
                    <span className="opacity-60">{k.note ?? "?"}</span>
                  ) : (
                    capLegend(k.usage)
                  )}
                </button>
              );
            })}
            {draft.knob && (
              <button
                type="button"
                onPointerDown={(e) => onPointerDown(e, { kind: "knob" })}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                data-selected={selected?.kind === "knob"}
                title={t("Knob")}
                className="knob-ring absolute cursor-grab data-[selected=true]:z-10 data-[selected=true]:outline-2 data-[selected=true]:outline-(--ring)"
                style={{
                  left: cq(draft.knob.x),
                  top: cq(draft.knob.y),
                  width: cq(KNOB_SIZE - CAP_GAP),
                  height: cq(KNOB_SIZE - CAP_GAP),
                }}
              >
                <span className="knob-cap absolute inset-[24%]" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2 text-center text-xs text-muted-foreground">
        {!checked ? (
          <p>{t("Checking the drawing against your board…")}</p>
        ) : !inference ? (
          <p>{t("Could not read the board's keymap, so the drawing cannot be checked.")}</p>
        ) : (
          <p>
            {t("{matched} of {total} keys match your board.", {
              matched: matched.size,
              total: labelled,
            })}
            {wrong > 0 &&
              " " +
                t("Dimmed keys carry a label your board does not have: click one, then pick its real label below.")}
            {unlabelled === 1 && " " + t("One key has no label yet.")}
            {unlabelled > 1 && " " + t("{n} keys have no label yet.", { n: unlabelled })}
          </p>
        )}
      </div>

      {missing.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("Your board also has")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-xs text-muted-foreground">
              {selectedKey
                ? t("Pick one to put it on the selected key.")
                : wrong > 0
                  ? t("Click a dimmed key first, then pick its real label here. With nothing selected, picking one adds a new key. Knob functions add the knob. Greyed ones cannot be drawn.")
                  : t("Pick one to add it as a new key. Knob functions add the knob. Greyed ones cannot be drawn.")}
            </p>
            <div className="flex flex-wrap gap-1">
              {missing.map((m) => (
                <button
                  key={m.label}
                  disabled={m.usage === null && m.knob === null}
                  onClick={() =>
                    m.knob === null
                      ? label(m.usage)
                      : addKnob(m.knob === "turn" ? undefined : m.knob)
                  }
                  className="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-40"
                >
                  {m.label}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className={cn(!selected && "opacity-60")}>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            {selected?.kind === "knob"
              ? t("Knob")
              : selectedKey
                ? selectedKey.usage === null
                  ? selectedKey.note
                    ? t("Unlabelled key, printed {note}", { note: selectedKey.note })
                    : t("Unlabelled key")
                  : t("Key: {label}", { label: legend(selectedKey.usage) })
                : t("Select a key above")}
          </CardTitle>
          {selected && (
            <Button size="sm" variant="outline" onClick={remove}>
              <Trash2 className="mr-1 h-3.5 w-3.5" /> {t("Remove")}
            </Button>
          )}
        </CardHeader>
        {selected?.kind === "knob" && draft.knob && (
          <CardContent className="space-y-2 text-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("Press")}
            </div>
            <div className="flex flex-wrap gap-1">
              {KNOB_PRESSES.map((p) => (
                <button
                  key={p.label}
                  onClick={() => apply({ ...draft, knob: { ...draft.knob!, press: p.entry } })}
                  data-on={draft.knob!.press[2] === p.entry[2]}
                  className="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent data-[on=true]:border-(--ring) data-[on=true]:bg-primary/10"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </CardContent>
        )}
        {selectedKey && (
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-muted-foreground">{t("Width")}</span>
              <div className="flex items-center gap-1">
                <Button
                  size="icon-sm"
                  variant="outline"
                  disabled={selectedKey.w <= STEP * 2}
                  onClick={() => updateKey(selectedKey.id, { w: selectedKey.w - STEP })}
                >
                  <Minus />
                </Button>
                <span className="w-12 text-center font-mono text-xs">{fmt(selectedKey.w)}</span>
                <Button
                  size="icon-sm"
                  variant="outline"
                  onClick={() => updateKey(selectedKey.id, { w: selectedKey.w + STEP })}
                >
                  <Plus />
                </Button>
              </div>
              <span className="text-xs text-muted-foreground">{t("Height")}</span>
              <div className="flex rounded-md border p-0.5">
                {[1, 2].map((h) => (
                  <button
                    key={h}
                    onClick={() => updateKey(selectedKey.id, { h })}
                    className={cn(
                      "rounded px-2 py-0.5 text-xs transition-colors",
                      selectedKey.h === h ? "bg-primary/10 font-medium" : "text-muted-foreground",
                    )}
                  >
                    {fmt(h)}
                  </button>
                ))}
              </div>
              <Button size="sm" variant="outline" onClick={addKey}>
                <Plus className="mr-1 h-3.5 w-3.5" /> {t("Add key to the right")}
              </Button>
            </div>
            <ScrollArea className="h-56">
              <div className="space-y-3 pr-3">
                <button
                  onClick={() => label(null)}
                  className="rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
                >
                  {t("No label")}
                </button>
                {DRAWABLE.map((g) => (
                  <div key={g.name}>
                    <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t(g.name)}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {g.items.map((item) => {
                        const holder = used.get(item.usage);
                        const here = holder === selectedKey.id;
                        return (
                          <button
                            key={`${g.name}-${item.usage}`}
                            onClick={() => label(item.usage)}
                            title={
                              holder !== undefined && !here
                                ? t("Already on another key")
                                : undefined
                            }
                            className={cn(
                              "rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent",
                              here && "border-(--ring) bg-primary/10",
                              holder !== undefined && !here && "text-muted-foreground",
                            )}
                          >
                            {item.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        )}
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={use} disabled={busy || !inference || rate < BAR}>
          {t("Use this drawing")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("Close")}
        </Button>
        {inference && rate < BAR && (
          <span className="text-xs text-muted-foreground">
            {t("At least {pct}% of the labelled keys must match before the drawing can be used.", {
              pct: Math.round(BAR * 100),
            })}
          </span>
        )}
      </div>
    </div>
  );
}
