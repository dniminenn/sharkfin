// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Per-device board layouts. Vendor layouts share x86.json's schema and are
// code-split; boards with no layout file get a plain 16×8 grid of the 128
// matrix slots so they are still fully editable.
import { useEffect, useState } from "react";
import x86 from "@/lib/layouts/x86.json";
import type { ConnectedDevice } from "@/lib/backend";

export interface LayoutKey {
  code: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string | null;
  matrixIndex: number | null;
  matrixEntry: number[];
  hidUsage: number | null;
  consumerUsage: number | null;
}

export interface BoardLayout {
  canvas: { width: number; height: number };
  keys: LayoutKey[];
  /** Synthesized slot grid; matrixEntry defaults are unknown. */
  grid?: boolean;
}

const VENDOR = import.meta.glob("./layouts/vendor/*.json");
const X86_NAME = "Common80_k72x86";

export const X86_LAYOUT = x86 as unknown as BoardLayout;

const CELL = 41;

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

export function useBoardLayout(device: ConnectedDevice | null): BoardLayout {
  const name = device?.spec.keyLayout;
  const [layout, setLayout] = useState<BoardLayout>(X86_LAYOUT);

  useEffect(() => {
    let live = true;
    if (!name || name === X86_NAME) {
      setLayout(X86_LAYOUT);
      return;
    }
    const load = VENDOR[`./layouts/vendor/${name}.json`];
    if (!load) {
      setLayout(gridLayout());
      return;
    }
    load()
      .then((m) => {
        if (!live) return;
        const mod = m as { default?: BoardLayout };
        setLayout(mod.default ?? (m as BoardLayout));
      })
      .catch(() => live && setLayout(gridLayout()));
    return () => {
      live = false;
    };
  }, [name]);

  return layout;
}
