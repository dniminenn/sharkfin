// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { BoardLayout, LayoutKey } from "@/lib/layout-loader";
import { DISABLED_GLYPH, PASSTHRU_GLYPH } from "@/lib/hid-usages";

export type { BoardLayout, LayoutKey };

// The knob's two rotations are named; whatever third knob key a board has
// is its press. Boards disagree on which slot that is, so it comes from
// the layout: a fixed slot number addresses an ordinary key on almost
// every board, and writing there remaps whatever happens to live at it.
const ROTATE_CODES = ["AudioVolumeDown", "AudioVolumeUp"];

function pressKey(knobKeys: LayoutKey[]): LayoutKey | undefined {
  return knobKeys.find((k) => !ROTATE_CODES.includes(k.code));
}

const ACCENT = new Set(["Escape", "Enter"]);
const MOD_USAGES = new Set([42, 43, 57, 74, 75, 76, 78, 79, 80, 81, 82]);

function role(k: LayoutKey): "accent" | "mod" | "base" {
  if (ACCENT.has(k.code)) return "accent";
  if ((k.matrixEntry?.[0] ?? 0) !== 0) return "mod";
  const u = k.hidUsage ?? 0;
  if ((u >= 224 && u <= 231) || MOD_USAGES.has(u)) return "mod";
  return "base";
}

const ROLE_VARS: Record<string, React.CSSProperties> = {
  base: { "--key": "var(--key-base)", "--key-fg": "var(--key-legend)" } as React.CSSProperties,
  mod: { "--key": "var(--key-mod)", "--key-fg": "var(--key-mod-legend)" } as React.CSSProperties,
  accent: { "--key": "var(--key-accent)", "--key-fg": "var(--key-accent-legend)" } as React.CSSProperties,
};

interface Props {
  layout: BoardLayout;
  selected: number | null;
  entries: Map<number, number[]>;
  modified: Set<number>;
  labelFor: (k: LayoutKey, entry: number[] | undefined) => string;
  onSelect: (k: LayoutKey) => void;
}

function describe(label: string) {
  if (label === DISABLED_GLYPH) return "does nothing";
  if (label === PASSTHRU_GLYPH) return "falls through to the base layer";
  return label;
}

function pct(v: number, of: number) {
  return `${(v / of) * 100}%`;
}

function Knob({
  layout,
  selected,
  onSelect,
}: Pick<Props, "layout" | "selected" | "onSelect">) {
  const knobKeys = layout.keys.filter((k) => k.type === "knob");
  if (!knobKeys.length) return null;
  const box = {
    x: Math.min(...knobKeys.map((k) => k.x)),
    y: Math.min(...knobKeys.map((k) => k.y)),
    w: Math.max(...knobKeys.map((k) => k.x + k.w)) - Math.min(...knobKeys.map((k) => k.x)),
    h: Math.max(...knobKeys.map((k) => k.y + k.h)) - Math.min(...knobKeys.map((k) => k.y)),
  };
  const down = knobKeys.find((k) => k.code === "AudioVolumeDown");
  const up = knobKeys.find((k) => k.code === "AudioVolumeUp");
  const press = pressKey(knobKeys);
  // A zone with no slot behind it cannot be written to, so it must not be
  // selectable: the assign panel would open on it and send the write to
  // whatever slot the code fell back to.
  const live = (k: LayoutKey | undefined) => !!k && k.matrixIndex !== null;
  return (
    <div
      className="absolute"
      style={{
        left: pct(box.x, layout.canvas.width),
        top: pct(box.y, layout.canvas.height),
        width: pct(box.w, layout.canvas.width),
        height: pct(box.h, layout.canvas.height),
      }}
    >
      <div className="knob-ring absolute inset-0" />
      <button
        title="Knob · rotate left"
        disabled={!live(down)}
        data-selected={live(down) && selected === down!.matrixIndex}
        onClick={() => live(down) && onSelect(down!)}
        className="knob-zone absolute inset-y-0 left-0 z-10 flex w-[38%] items-center justify-start"
      >
        <span className="knob-target knob-arc flex h-[45%] w-[70%] items-center justify-center">
          <ChevronLeft className="h-full w-full" strokeWidth={3} />
        </span>
      </button>
      <button
        title="Knob · rotate right"
        disabled={!live(up)}
        data-selected={live(up) && selected === up!.matrixIndex}
        onClick={() => live(up) && onSelect(up!)}
        className="knob-zone absolute inset-y-0 right-0 z-10 flex w-[38%] items-center justify-end"
      >
        <span className="knob-target knob-arc flex h-[45%] w-[70%] items-center justify-center">
          <ChevronRight className="h-full w-full" strokeWidth={3} />
        </span>
      </button>
      <button
        title="Knob · press"
        disabled={!live(press)}
        data-selected={live(press) && selected === press!.matrixIndex}
        onClick={() => live(press) && onSelect(press!)}
        className="knob-zone absolute left-1/2 top-1/2 z-20 h-[52%] w-[52%] -translate-x-1/2 -translate-y-1/2"
      >
        <span className="knob-target knob-cap absolute inset-0 flex items-center justify-center">
          <span className="h-[30%] w-[30%] rounded-full bg-current opacity-70" />
        </span>
      </button>
    </div>
  );
}

export default function KeyboardView({
  layout,
  selected,
  entries,
  modified,
  labelFor,
  onSelect,
}: Props) {
  // Geometry is enough to draw a key; a matrix slot is only needed to edit
  // it. Keys without one render dimmed and inert so the picture is complete.
  const plainKeys = useMemo(
    () => layout.keys.filter((k) => k.type !== "knob"),
    [layout],
  );
  return (
    <div className="w-full" style={{ containerType: "inline-size" }}>
      <div className="keycap-plate mx-auto max-w-[920px] rounded-2xl p-[1.6%]">
        <div
          className="relative"
          style={{ aspectRatio: `${layout.canvas.width} / ${layout.canvas.height}` }}
        >
          {plainKeys.map((k, i) => {
            const dead = k.matrixIndex === null;
            const entry = dead ? undefined : entries.get(k.matrixIndex!);
            const isMod = !dead && modified.has(k.matrixIndex!);
            return (
              <button
                key={`${k.code}-${k.matrixIndex ?? `dead-${i}`}`}
                disabled={dead}
                onClick={() => onSelect(k)}
                title={
                  dead
                    ? `${k.text ?? k.code}: not matched to this board`
                    : `${k.text ?? k.code}: ${describe(labelFor(k, entry))}`
                }
                data-selected={!dead && selected === k.matrixIndex}
                className={`keycap absolute flex items-center justify-center overflow-hidden rounded-[8%] text-[1.15cqw] font-medium leading-none tracking-tight${dead ? " opacity-40" : ""}`}
                style={{
                  ...ROLE_VARS[role(k)],
                  left: pct(k.x, layout.canvas.width),
                  top: pct(k.y, layout.canvas.height),
                  width: pct(k.w, layout.canvas.width),
                  height: pct(k.h, layout.canvas.height),
                }}
              >
                {labelFor(k, entry)}
                {isMod && (
                  <span className="absolute right-[8%] top-[8%] h-[0.45em] w-[0.45em] rounded-full bg-(--ring)" />
                )}
              </button>
            );
          })}
          <Knob layout={layout} selected={selected} onSelect={onSelect} />
        </div>
      </div>
    </div>
  );
}
