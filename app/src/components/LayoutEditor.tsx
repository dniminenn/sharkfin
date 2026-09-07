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
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { BoardLayout } from "@/lib/layout-loader";
import type { Inference } from "@/lib/layout-infer";
import { CODE_TO_USAGE, entryLabel } from "@/lib/hid-usages";
import { directUsage, matchRank } from "@/components/KeyPicker";
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
  /** What the header calls the job: drawing a board that has no picture,
   *  or editing one it has. */
  title: string;
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

const CODE_OF: Record<number, string> = Object.fromEntries(
  Object.entries(CODE_TO_USAGE).map(([c, u]) => [u, c.toLowerCase()]),
);

/** A preset at a glance: its caps as a small drawing on plate colours. */
function Silhouette({ draft }: { draft: Draft }) {
  const e = extent(draft);
  const gap = 0.12;
  return (
    <svg viewBox={`0 0 ${e.width} ${e.height}`} className="h-auto w-full text-(--key-base)" aria-hidden>
      {draft.keys.map((k) => (
        <rect
          key={k.id}
          x={k.x + gap / 2}
          y={k.y + gap / 2}
          width={k.w - gap}
          height={k.h - gap}
          rx={0.12}
          fill={k.usage === null ? "var(--key-plate)" : "currentColor"}
          stroke={k.usage === null ? "var(--key-mod)" : "none"}
          strokeWidth={0.04}
        />
      ))}
      {draft.knob && (
        <circle
          cx={draft.knob.x + KNOB_SIZE / 2}
          cy={draft.knob.y + KNOB_SIZE / 2}
          r={(KNOB_SIZE - gap) / 2}
          fill="var(--key-accent)"
        />
      )}
    </svg>
  );
}

export default function LayoutEditor({
  title,
  draft,
  onChange,
  nearest,
  preview,
  onUse,
  onClose,
}: Props) {
  const [selected, setSelected] = useState<Selection>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
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
    if ((e.target as HTMLElement).tagName === "INPUT") return;
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
    else if (d) {
      setQuery("");
      setOpen(true);
    }
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

  const q = query.trim().toLowerCase();
  const rankOf = (g: (typeof DRAWABLE)[number], i: (typeof DRAWABLE)[number]["items"][number]) =>
    matchRank(q, i.label, typeof i.usage === "number" ? CODE_OF[i.usage] : undefined, g.name);
  const pickable = useMemo(() => {
    if (!q) return DRAWABLE;
    return DRAWABLE.map((g) => ({
      ...g,
      items: g.items.filter((i) => rankOf(g, i) >= 0),
    })).filter((g) => g.items.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  // The best match across every group, not the first group's first item.
  const firstPick = useMemo(() => {
    if (!q) return undefined;
    let best: { rank: number; item: (typeof DRAWABLE)[number]["items"][number] } | undefined;
    for (const g of pickable)
      for (const i of g.items) {
        const rank = rankOf(g, i);
        if (!best || rank < best.rank) best = { rank, item: i };
      }
    return best?.item;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, pickable]);

  // On the cap: Enter takes the first match, Escape lets go, arrows nudge,
  // Delete on an empty field removes the key, and a key that is not a
  // character labels the cap with itself.
  const onCapKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setSelected(null);
      plateRef.current?.focus();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (q && firstPick) label(firstPick.usage);
      return;
    }
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const step = e.shiftKey ? 1 : STEP;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d) nudge(d[0], d[1]);
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && !query) {
      e.preventDefault();
      remove();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !query) {
      e.preventDefault();
      undo();
      return;
    }
    const usage = directUsage(e);
    if (usage !== undefined && DRAWABLE.some((g) => g.items.some((i) => i.usage === usage))) {
      e.preventDefault();
      label(usage);
    }
  };

  const labelled = draft?.keys.filter((k) => k.usage !== null).length ?? 0;
  const unlabelled = (draft?.keys.length ?? 0) - labelled;
  const wrong = labelled - matched.size;
  const rate = inference?.matchRate ?? 0;

  const anchorBox = (() => {
    if (!draft || !selected) return null;
    if (selected.kind === "knob")
      return draft.knob ? { x: draft.knob.x, y: draft.knob.y, w: KNOB_SIZE, h: KNOB_SIZE } : null;
    return selectedKey ? { x: selectedKey.x, y: selectedKey.y, w: selectedKey.w, h: selectedKey.h } : null;
  })();

  if (!draft) {
    return (
      <div className="space-y-5 motion-safe:animate-in motion-safe:fade-in">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t("Pick a starting point. Each key then shows whether your board has it, and anything the board has that is not drawn is listed to add.")}
          </p>
        </div>
        {history.length > 0 && (
          <Button size="sm" onClick={undo}>
            <Undo2 className="mr-1 h-3.5 w-3.5" /> {t("Back to the drawing")}
          </Button>
        )}
        <div className="flex flex-wrap gap-5 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-(--primary)" checked={iso} onChange={(e) => setIso(e.target.checked)} />
            {t("ISO layout")}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-(--primary)" checked={knob} onChange={(e) => setKnob(e.target.checked)} />
            {t("Has a knob")}
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {nearest && (
            <button
              type="button"
              onClick={() => start(fromLayout(nearest.layout))}
              className="keycap-plate group flex flex-col items-start gap-2 rounded-xl p-3 text-left transition-transform hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-(--ring)"
            >
              <Silhouette draft={fromLayout(nearest.layout)} />
              <span className="text-sm font-medium text-(--key-legend)">{t("Closest stored picture")}</span>
              <span className="text-xs text-(--key-mod-legend)">
                {t("{what}, {matched} of {total} match", {
                  what: describe(nearest.layout),
                  matched: nearest.matched,
                  total: nearest.total,
                })}
              </span>
            </button>
          )}
          {PRESETS.map((p) => {
            const s = scores[p.size];
            const best = bestPreset === p.size;
            const d = preset(p.size, { iso, knob });
            return (
              <button
                key={p.size}
                type="button"
                onClick={() => start(d)}
                className={cn(
                  "keycap-plate group flex flex-col items-start gap-2 rounded-xl p-3 text-left transition-transform hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-(--ring)",
                  best && "outline-2 outline-(--ring)",
                )}
              >
                <Silhouette draft={d} />
                <span className="text-sm font-medium text-(--key-legend)">
                  {p.label}
                  {best && <span className="ml-2 text-xs font-normal text-(--key-accent)">{t("best fit")}</span>}
                </span>
                <span className="text-xs text-(--key-mod-legend)">
                  {s
                    ? t("{matched} of {total} match", { matched: s.matched, total: s.total })
                    : t("{n} keys", { n: d.keys.length })}
                </span>
              </button>
            );
          })}
        </div>
        <div className="space-y-2 text-sm">
          <button className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => setPasting((v) => !v)}>
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
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("Close")}
        </Button>
      </div>
    );
  }

  const cq = (u: number) => `${(u / size.width) * 100}cqw`;

  return (
    <div className="space-y-4 motion-safe:animate-in motion-safe:fade-in">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">
            {t("Click a key to label or resize it, drag to move. Arrow keys nudge, Delete removes.")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={undo} disabled={!history.length}>
            <Undo2 className="mr-1 h-3.5 w-3.5" /> {t("Undo")}
          </Button>
          <Button size="sm" variant="ghost" onClick={addKey}>
            <Plus className="mr-1 h-3.5 w-3.5" /> {t("Add key")}
          </Button>
          {!draft.knob && (
            <Button size="sm" variant="ghost" onClick={() => addKnob()}>
              <Plus className="mr-1 h-3.5 w-3.5" /> {t("Add knob")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => start(null)}>
            {t("Start over")}
          </Button>
        </div>
      </div>

      <Popover
        open={open && !!anchorBox}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) plateRef.current?.focus();
        }}
      >
      <div className="w-full">
        <div className="keycap-plate mx-auto max-w-[920px] rounded-2xl p-[1.6%]">
          <div
            ref={plateRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) {
                setSelected(null);
                setOpen(false);
              }
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
            {anchorBox && (
              <PopoverAnchor asChild>
                <div
                  className={open && selectedKey ? "absolute" : "pointer-events-none absolute"}
                  style={{
                    left: cq(anchorBox.x),
                    top: cq(anchorBox.y),
                    width: cq(anchorBox.w - CAP_GAP),
                    height: cq(anchorBox.h - CAP_GAP),
                  }}
                >
                  {open && selectedKey && (
                    <input
                      autoFocus
                      value={query}
                      placeholder={selectedKey.usage === null ? "?" : capLegend(selectedKey.usage)}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={onCapKey}
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={t("Type the legend, like PgUp or F13")}
                      className="keycap absolute inset-0 z-20 w-full rounded-[8%] text-center font-medium leading-none tracking-tight outline-none placeholder:opacity-50"
                      style={
                        {
                          "--key": "var(--key-accent)",
                          "--key-fg": "var(--key-accent-legend)",
                          color: "var(--key-fg)",
                          fontSize: cq(0.28),
                        } as React.CSSProperties
                      }
                    />
                  )}
                </div>
              </PopoverAnchor>
            )}
          </div>
        </div>
      </div>

      {selected?.kind === "knob" && draft.knob && (
        <PopoverContent side="bottom" sideOffset={10} className="w-64 space-y-3 p-3" onOpenAutoFocus={(e) => e.preventDefault()}>
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-semibold">{t("Knob")}</span>
            <Button size="xs" variant="ghost" onClick={remove}>
              <Trash2 /> {t("Remove")}
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">{t("Press")}</div>
          <div className="flex flex-wrap gap-1">
            {KNOB_PRESSES.map((p) => (
              <button
                key={p.label}
                onClick={() => apply({ ...draft, knob: { ...draft.knob!, press: p.entry } })}
                data-on={draft.knob!.press[2] === p.entry[2]}
                className="rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent data-[on=true]:bg-primary data-[on=true]:text-primary-foreground"
              >
                {p.label}
              </button>
            ))}
          </div>
        </PopoverContent>
      )}
      {selectedKey && (
        <PopoverContent side="bottom" sideOffset={10} className="w-80 space-y-3 p-3" onOpenAutoFocus={(e) => e.preventDefault()}>
          <div className="flex items-baseline justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-mono text-sm font-semibold">
                {selectedKey.usage === null
                  ? (selectedKey.note ?? t("No label"))
                  : legend(selectedKey.usage)}
              </div>
              {selectedKey.usage === null && (
                <div className="text-xs text-muted-foreground">
                  {selectedKey.note ? t("Printed on the stored picture, not a key sharkfin knows.") : t("Pick what is printed on it.")}
                </div>
              )}
            </div>
            <Button size="xs" variant="ghost" onClick={remove}>
              <Trash2 /> {t("Remove")}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{t("Width")}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={selectedKey.w <= STEP * 2}
              onClick={() => updateKey(selectedKey.id, { w: selectedKey.w - STEP })}
            >
              <Minus />
            </Button>
            <span className="w-10 text-center font-mono text-foreground">{fmt(selectedKey.w)}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => updateKey(selectedKey.id, { w: selectedKey.w + STEP })}
            >
              <Plus />
            </Button>
            <span className="ml-2">{t("Height")}</span>
            <div className="flex rounded-md bg-muted p-[2px]">
              {[1, 2].map((h) => (
                <button
                  key={h}
                  onClick={() => updateKey(selectedKey.id, { h })}
                  data-on={selectedKey.h === h}
                  className="rounded px-2 py-0.5 transition-colors data-[on=true]:bg-background data-[on=true]:text-foreground"
                >
                  {fmt(h)}
                </button>
              ))}
            </div>
            <Button size="xs" variant="ghost" onClick={addKey}>
              <Plus /> {t("Add one to the right")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {q
              ? t("Enter takes the outlined match.")
              : t("Type the legend on the key, like PgUp or F13, or press that key on another keyboard.")}
          </p>
          <div className="max-h-56 space-y-3 overflow-y-auto pr-1">
            {!q && (
              <button
                onClick={() => label(null)}
                className="rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
              >
                {t("No label")}
              </button>
            )}
            {pickable.map((g) => (
              <div key={g.name}>
                <div className="mb-1 px-1 text-xs text-muted-foreground">{t(g.name)}</div>
                <div className="flex flex-wrap gap-1">
                  {g.items.map((item) => {
                    const holder = used.get(item.usage);
                    const here = holder === selectedKey.id;
                    return (
                      <button
                        key={`${g.name}-${item.usage}`}
                        onClick={() => label(item.usage)}
                        title={holder !== undefined && !here ? t("Already on another key") : undefined}
                        data-on={here}
                        data-first={!!q && item === firstPick}
                        className={cn(
                          "rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent data-[first=true]:ring-1 data-[first=true]:ring-(--ring) data-[on=true]:bg-primary data-[on=true]:text-primary-foreground",
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
            {q && !pickable.length && (
              <p className="px-1 py-2 text-xs text-muted-foreground">{t("No key called that.")}</p>
            )}
          </div>
        </PopoverContent>
      )}
      </Popover>

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
        <div className="space-y-1.5 text-center text-xs text-muted-foreground">
          <p>
            {selectedKey
              ? t("Your board also has these. Pick one to put it on the selected key.")
              : wrong > 0
                ? t("Your board also has these. Click a dimmed key first to relabel it, or pick one to add a key. Greyed ones cannot be drawn.")
                : t("Your board also has these. Pick one to add it as a key. Greyed ones cannot be drawn.")}
          </p>
          <div className="flex flex-wrap justify-center gap-1">
            {missing.map((m) => (
              <button
                key={m.label}
                disabled={m.usage === null && m.knob === null}
                onClick={() =>
                  m.knob === null
                    ? label(m.usage)
                    : addKnob(m.knob === "turn" ? undefined : m.knob)
                }
                className="keycap rounded-md px-2 py-1 font-mono text-xs disabled:opacity-40"
                style={{ "--key": "var(--key-base)", "--key-fg": "var(--key-legend)" } as React.CSSProperties}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={use} disabled={busy || !inference || rate < BAR}>
          {t("Use this picture")}
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
