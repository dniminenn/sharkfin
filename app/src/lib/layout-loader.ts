// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Per-device board layouts. Vendor layouts share x86.json's schema and are
// code-split; boards with no layout file get a plain 16×8 grid of the 128
// matrix slots so they are still fully editable.
import { useCallback, useEffect, useState } from "react";
import x86 from "@/lib/layouts/x86.json";
import { readKeymap, type ConnectedDevice } from "@/lib/backend";
import { inferSlots, type Inference } from "@/lib/layout-infer";

export interface LayoutKey {
  code: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string | null;
  matrixIndex: number | null;
  matrixEntry: number[] | null;
  hidUsage: number | null;
  consumerUsage: number | null;
}

export interface BoardLayout {
  canvas: { width: number; height: number };
  keys: LayoutKey[];
  /** Synthesized slot grid; matrixEntry defaults are unknown. */
  grid?: boolean;
  /** Slots matched against the connected board, not vendor data. */
  inferred?: boolean;
}

export interface BoardLayoutState {
  layout: BoardLayout;
  /** Inferred and not yet confirmed by the user; keymap writes stay gated. */
  pending: boolean;
  inference: Inference | null;
  confirm: () => void;
  reject: () => void;
}

const VENDOR = import.meta.glob("./layouts/vendor/*.json");
const X86_NAME = "Common80_k72x86";
// The registry's placeholder for a board with no layout data. A file of
// that name exists but describes no particular board, so it is never
// matched against a live keymap.
const UNKNOWN_NAME = "Unknown";

export const X86_LAYOUT = x86 as unknown as BoardLayout;

const CELL = 41;

// Extraction fills matrixIndex only when the vendor bundle carries a
// defaultMatrix for the layout; many files have none. A key without a slot
// cannot be rendered or edited, so such a layout is no better than no file.
function usable(layout: BoardLayout): boolean {
  return layout.keys.some((k) => k.matrixIndex !== null);
}

const confirmedKey = (id: number) => `sharkfin.layout-confirmed.${id}`;
const rejectedKey = (id: number) => `sharkfin.layout-rejected.${id}`;

export function gridLayout(): BoardLayout {
  const keys: LayoutKey[] = Array.from({ length: 128 }, (_, i) => ({
    code: `Slot${i}`,
    type: "key",
    x: (i % 16) * CELL + 1,
    y: Math.floor(i / 16) * CELL + 1,
    w: CELL - 1,
    h: CELL - 1,
    text: `${i}`,
    matrixIndex: i,
    matrixEntry: [0, 0, 0, 0],
    hidUsage: null,
    consumerUsage: null,
  }));
  return {
    canvas: { width: 16 * CELL + 1, height: 8 * CELL + 1 },
    keys,
    grid: true,
  };
}

export function useBoardLayout(device: ConnectedDevice | null): BoardLayoutState {
  const name = device?.spec.keyLayout;
  const id = device?.spec.id;
  const profiles = device?.spec.profiles ?? 1;
  const [layout, setLayout] = useState<BoardLayout>(X86_LAYOUT);
  const [pending, setPending] = useState(false);
  const [inference, setInference] = useState<Inference | null>(null);

  useEffect(() => {
    let live = true;
    setPending(false);
    setInference(null);
    if (!name || name === X86_NAME) {
      setLayout(X86_LAYOUT);
      return;
    }
    const load = VENDOR[`./layouts/vendor/${name}.json`];
    if (!load) {
      setLayout(gridLayout());
      return;
    }
    (async () => {
      let loaded: BoardLayout;
      try {
        const m = await load();
        const mod = m as { default?: BoardLayout };
        loaded = mod.default ?? (m as BoardLayout);
      } catch {
        if (live) setLayout(gridLayout());
        return;
      }
      if (!live) return;
      if (usable(loaded)) {
        setLayout(loaded);
        return;
      }
      // No slot data in the file. The board's own keymap is the only
      // remaining source; trust nothing short of a near-total match, and
      // a user who already said the picture is wrong keeps the grid. A
      // remapped profile misses the bar, so every profile gets a try.
      setLayout(gridLayout());
      if (id === undefined || name === UNKNOWN_NAME) return;
      if (localStorage.getItem(rejectedKey(id))) return;
      try {
        for (let p = 0; p < Math.max(1, profiles); p++) {
          const matrix = await readKeymap(p);
          if (!live) return;
          const inf = inferSlots(loaded, matrix);
          if (inf.matchRate < 0.9) continue;
          inf.profile = p;
          setInference(inf);
          setLayout(inf.layout);
          setPending(!localStorage.getItem(confirmedKey(id)));
          return;
        }
      } catch {
        // The grid is already up.
      }
    })();
    return () => {
      live = false;
    };
  }, [name, id, profiles]);

  const confirm = useCallback(() => {
    if (id !== undefined) localStorage.setItem(confirmedKey(id), "1");
    setPending(false);
  }, [id]);

  const reject = useCallback(() => {
    if (id !== undefined) localStorage.setItem(rejectedKey(id), "1");
    setPending(false);
    setLayout(gridLayout());
  }, [id]);

  return { layout, pending, inference, confirm, reject };
}
