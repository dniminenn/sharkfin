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
  /** Still working out which picture this board gets. Until it settles,
   *  `layout` is a placeholder and drawing it shows the wrong keyboard. */
  resolving: boolean;
  /** Inferred and not yet confirmed by the user; keymap writes stay gated. */
  pending: boolean;
  inference: Inference | null;
  /** Candidate pictures left to try after the current one. */
  remaining: number;
  confirm: () => void;
  reject: () => void;
  /** Forget the stored answer and work the picture out again. A confirmed
   *  picture is otherwise final, and a key missing from it is only noticed
   *  after confirming. */
  recheck: () => void;
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
function usable(layout: BoardLayout | null): boolean {
  return !!layout?.keys?.some?.((k) => k.matrixIndex !== null);
}

// Site data can be blocked or full; storage is a convenience here, never a
// reason to fail. A throw from it used to leave the app resolving forever.
function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the choice simply is not remembered next time.
  }
}

function clearStore(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // As above.
  }
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
  const [resolving, setResolving] = useState(true);
  const [pending, setPending] = useState(false);
  const [inference, setInference] = useState<Inference | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const matricesRef = useRef<number[][]>([]);
  const candidatesRef = useRef<Inference[]>([]);
  const indexRef = useRef(0);
  /** The shipped picture, when there is one to go back to. */
  const fallbackRef = useRef<BoardLayout | null>(null);

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
    setResolving(true);
    setPending(false);
    setInference(null);
    setRemaining(0);
    matricesRef.current = [];
    candidatesRef.current = [];
    indexRef.current = 0;
    fallbackRef.current = null;
    if (!name || name === X86_NAME) {
      setLayout(X86_LAYOUT);
      setResolving(false);
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
        //
        // This settles before the picture is shown. Drawing the shipped
        // one first would show the board a keyboard it then swaps out.
        if (id !== undefined && !readStore(rejectedKey(id))) {
          const matrices = await readMatrices();
          if (!live) return;
          if (matrices.length) {
            const fit = Math.max(...matrices.map((m) => agreement(named, m)));
            const alt = bestMatch(named, name, matrices);
            if (alt && alt.f1 >= fit + RETHINK_MARGIN && alt.matchRate >= MATCH_BAR) {
              setInference(alt);
              setLayout(alt.layout);
              candidatesRef.current = [alt];
              indexRef.current = 0;
              fallbackRef.current = named;
              // Only a confirmation of THIS picture counts. Treating any
              // stored answer as a yes would adopt an unreviewed
              // assignment on a board whose file changed under it.
              setPending(readStore(confirmedKey(id)) !== alt.layoutName);
            }
          }
        }
        setResolving(false);
        return;
      }
      // No slot data anywhere for this board. The board's own keymap is
      // the only remaining source; trust nothing short of a near-total
      // match, and a user who already said no keeps the grid. A remapped
      // profile misses the bar, so every profile gets a try.
      setLayout(gridLayout());
      setResolving(false);
      if (id === undefined || readStore(rejectedKey(id))) return;
      const matrices = await readMatrices();
      if (!live || !matrices.length) return;

      // A picture confirmed earlier is re-matched and used silently.
      const stored = readStore(confirmedKey(id));
      if (stored) {
        let geometry: BoardLayout | null = null;
        if (stored === "kle") {
          const raw = readStore(customKey(id));
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
  }, [name, id, readMatrices, attempt]);

  const confirm = useCallback(() => {
    setInference((inf) => {
      if (id !== undefined && inf) {
        writeStore(confirmedKey(id), inf.layoutName || "1");
        if (inf.layoutName === "kle")
          writeStore(
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
    if (id !== undefined) writeStore(rejectedKey(id), "1");
    setPending(false);
    setRemaining(0);
    setInference(null);
    // Saying "wrong" to a rival assignment restores the shipped picture,
    // which is still the best thing known about the board. Only a board
    // that never had one falls back to the slot grid.
    setLayout(fallbackRef.current ?? gridLayout());
  }, [id]);

  const recheck = useCallback(() => {
    if (id !== undefined) {
      clearStore(confirmedKey(id));
      clearStore(rejectedKey(id));
      clearStore(customKey(id));
    }
    matricesRef.current = [];
    setAttempt((n) => n + 1);
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
        if (id !== undefined) clearStore(rejectedKey(id));
      }
      return inf.matchRate;
    },
    [id, readMatrices],
  );

  return {
    layout,
    resolving,
    pending,
    inference,
    remaining,
    confirm,
    reject,
    recheck,
    tryCustom,
  };
}
