// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Per-device board layouts. Vendor layouts share x86.json's schema and are
// code-split; boards with no layout file get a plain 16×8 grid of the 128
// matrix slots so they are still fully editable.
import { useCallback, useEffect, useRef, useState } from "react";
import x86 from "@/lib/layouts/x86.json";
import { readKeymap, type ConnectedDevice } from "@/lib/backend";
import { agreement, inferSlots, type Inference } from "@/lib/layout-infer";

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
  /** Candidate pictures left to try after the current one. */
  remaining: number;
  confirm: () => void;
  reject: () => void;
  /** Match a pasted drawing against the board; returns the match rate and,
   *  when it clears the bar, makes it the pending picture. */
  tryCustom: (layout: BoardLayout) => Promise<number>;
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
const customKey = (id: number) => `sharkfin.layout-custom.${id}`;

/** A picture needs at least this fraction of its keys tied to slots before
 *  it is offered at all. */
const MATCH_BAR = 0.9;
/** How much better a rival assignment must fit before it displaces the
 *  shipped one. This margin is the whole test: a board that merely ships
 *  different factory functions matches the same slots either way, so no
 *  rival gains ground, and a remapped board makes every assignment fit
 *  worse rather than one better. It also means a layout the board already
 *  agrees with cannot be displaced, since no score exceeds 1. */
const RETHINK_MARGIN = 0.15;
/** Candidate pictures offered before giving up on the collection. */
const MAX_CANDIDATES = 8;

async function loadVendor(name: string): Promise<BoardLayout | null> {
  const load = VENDOR[`./layouts/vendor/${name}.json`];
  if (!load) return null;
  try {
    const m = (await load()) as { default?: BoardLayout };
    return m.default ?? (m as BoardLayout);
  } catch {
    return null;
  }
}

/** Best match for one geometry across every profile's keymap. */
function bestMatch(
  geometry: BoardLayout,
  name: string,
  matrices: number[][],
): Inference | null {
  let best: Inference | null = null;
  for (let p = 0; p < matrices.length; p++) {
    const inf = inferSlots(geometry, matrices[p]);
    inf.profile = p;
    inf.layoutName = name;
    if (!best || inf.f1 > best.f1) best = inf;
  }
  return best;
}

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
  const [remaining, setRemaining] = useState(0);
  const matricesRef = useRef<number[][]>([]);
  const candidatesRef = useRef<Inference[]>([]);
  const indexRef = useRef(0);

  const readMatrices = useCallback(async () => {
    if (matricesRef.current.length) return matricesRef.current;
    const out: number[][] = [];
    for (let p = 0; p < Math.max(1, profiles); p++) {
      try {
        out.push(await readKeymap(p));
      } catch {
        break;
      }
    }
    matricesRef.current = out;
    return out;
  }, [profiles]);

  useEffect(() => {
    let live = true;
    setPending(false);
    setInference(null);
    setRemaining(0);
    matricesRef.current = [];
    candidatesRef.current = [];
    indexRef.current = 0;
    if (!name || name === X86_NAME) {
      setLayout(X86_LAYOUT);
      return;
    }
    (async () => {
      const named = name === UNKNOWN_NAME ? null : await loadVendor(name);
      if (!live) return;
      if (named && usable(named)) {
        setLayout(named);
        // Layout files are shared between boards, and boards sharing one
        // do not always ship the same factory keymap, so the slots can be
        // right for a sibling and wrong here. Keep them only while the
        // board itself agrees; a board that fits a different assignment
        // markedly better gets that one, and the user confirms it before
        // anything is written. A board that fits neither has been
        // remapped, which is not a reason to doubt the file.
        if (id === undefined || localStorage.getItem(rejectedKey(id))) return;
        const matrices = await readMatrices();
        if (!live || !matrices.length) return;
        const fit = Math.max(...matrices.map((m) => agreement(named, m)));
        const alt = bestMatch(named, name, matrices);
        if (!alt || alt.f1 < fit + RETHINK_MARGIN || alt.matchRate < MATCH_BAR) return;
        setInference(alt);
        setLayout(alt.layout);
        setPending(!localStorage.getItem(confirmedKey(id)));
        return;
      }
      // No slot data anywhere for this board. The board's own keymap is
      // the only remaining source; trust nothing short of a near-total
      // match, and a user who already said no keeps the grid. A remapped
      // profile misses the bar, so every profile gets a try.
      setLayout(gridLayout());
      if (id === undefined || localStorage.getItem(rejectedKey(id))) return;
      const matrices = await readMatrices();
      if (!live || !matrices.length) return;

      // A picture confirmed earlier is re-matched and used silently.
      const stored = localStorage.getItem(confirmedKey(id));
      if (stored) {
        let geometry: BoardLayout | null = null;
        if (stored === "kle") {
          const raw = localStorage.getItem(customKey(id));
          if (raw) geometry = JSON.parse(raw) as BoardLayout;
        } else {
          geometry = await loadVendor(stored === "1" ? name : stored);
        }
        if (!live) return;
        const inf = geometry
          ? bestMatch(geometry, stored === "kle" ? "kle" : stored === "1" ? name : stored, matrices)
          : null;
        if (inf && inf.matchRate >= MATCH_BAR) {
          setInference(inf);
          setLayout(inf.layout);
        }
        return;
      }

      // Nothing confirmed yet: sweep the whole collection and offer the
      // closest pictures, the registry's own suggestion first.
      const candidates: Inference[] = [];
      for (const path of Object.keys(VENDOR)) {
        const stem = path.slice("./layouts/vendor/".length, -".json".length);
        if (stem === UNKNOWN_NAME) continue;
        const geometry = await loadVendor(stem);
        if (!live) return;
        if (!geometry) continue;
        const inf = bestMatch(geometry, stem, matrices);
        if (inf && inf.matchRate >= MATCH_BAR) candidates.push(inf);
      }
      candidates.sort(
        (a, b) =>
          Number(b.layoutName === name) - Number(a.layoutName === name) ||
          b.f1 - a.f1 ||
          a.ambiguous.length - b.ambiguous.length,
      );
      candidates.splice(MAX_CANDIDATES);
      if (!candidates.length) return;
      candidatesRef.current = candidates;
      indexRef.current = 0;
      setInference(candidates[0]);
      setLayout(candidates[0].layout);
      setRemaining(candidates.length - 1);
      setPending(true);
    })();
    return () => {
      live = false;
    };
  }, [name, id, readMatrices]);

  const confirm = useCallback(() => {
    setInference((inf) => {
      if (id !== undefined && inf) {
        localStorage.setItem(confirmedKey(id), inf.layoutName || "1");
        if (inf.layoutName === "kle")
          localStorage.setItem(
            customKey(id),
            JSON.stringify({
              canvas: inf.layout.canvas,
              keys: inf.layout.keys.map((k) => ({ ...k, matrixIndex: null })),
            }),
          );
      }
      return inf;
    });
    setPending(false);
  }, [id]);

  const reject = useCallback(() => {
    const next = indexRef.current + 1;
    if (next < candidatesRef.current.length) {
      indexRef.current = next;
      const inf = candidatesRef.current[next];
      setInference(inf);
      setLayout(inf.layout);
      setRemaining(candidatesRef.current.length - next - 1);
      return;
    }
    if (id !== undefined) localStorage.setItem(rejectedKey(id), "1");
    setPending(false);
    setRemaining(0);
    setInference(null);
    setLayout(gridLayout());
  }, [id]);

  const tryCustom = useCallback(
    async (geometry: BoardLayout) => {
      const matrices = await readMatrices();
      if (!matrices.length) return 0;
      const inf = bestMatch(geometry, "kle", matrices);
      if (!inf) return 0;
      if (inf.matchRate >= MATCH_BAR) {
        candidatesRef.current = [inf];
        indexRef.current = 0;
        setInference(inf);
        setLayout(inf.layout);
        setRemaining(0);
        setPending(true);
        if (id !== undefined) localStorage.removeItem(rejectedKey(id));
      }
      return inf.matchRate;
    },
    [id, readMatrices],
  );

  return { layout, pending, inference, remaining, confirm, reject, tryCustom };
}
