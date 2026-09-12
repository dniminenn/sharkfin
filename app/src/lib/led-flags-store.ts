// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Two firmware lineages read the rainbow flag the other way round, so a
// board can show a solid colour where the owner asked for the rainbow. The
// registry says which way round a board is where that is known; this is the
// owner's answer for their own board, kept by device id. `dflt` records what
// the registry said when they answered: if it has changed since, the board
// has been evidenced and the registry wins.
const FLAGS_STORE = "sharkfin.ledflags";

export interface FlagChoice {
  swapped: boolean;
  dflt: boolean;
}

export function readChoice(id: number): FlagChoice | null {
  try {
    const raw = localStorage.getItem(`${FLAGS_STORE}.${id}`);
    if (raw) {
      const c = JSON.parse(raw);
      if (typeof c?.swapped === "boolean" && typeof c?.dflt === "boolean") return c;
    }
  } catch {
    // Storage can be blocked; there is then no choice on file.
  }
  return null;
}

export function writeChoice(id: number, choice: FlagChoice | null) {
  try {
    if (choice) localStorage.setItem(`${FLAGS_STORE}.${id}`, JSON.stringify(choice));
    else localStorage.removeItem(`${FLAGS_STORE}.${id}`);
  } catch {
    // Nothing to do: the choice simply is not remembered next time.
  }
}

/** The reading to use for this board: the owner's answer while the registry
 *  still says what it said when they gave it, else the registry's. */
export function effectiveSwap(id: number, dflt: boolean): boolean {
  const stale = readChoice(id);
  if (stale && stale.dflt !== dflt) writeChoice(id, null);
  return stale && stale.dflt === dflt ? stale.swapped : dflt;
}
