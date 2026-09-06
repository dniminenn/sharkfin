// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Dynamic-keystroke action bytes, as the gen2 engine reads them
// (2268_v309, 0x0800c8a4..0x0800cccc; docs/PROTOCOL.md "Dynamic keystroke").
// One byte per sub-layer, four 2-bit cells, one per travel event in order:
// press past the first point, press past the second, release past the
// second, release past the first.

/** Nothing, a tap at one event, or a hold from one event to a later one.
 *  Events are 0..3. `end` equal to `start` is a tap; `end` is otherwise
 *  the event that releases, later than `start`. */
export interface DksAction {
  start: number | null;
  end: number;
}

/** Cell 1 taps at its event. Cell 2 presses at its event and releases at the
 *  next. Cell 3 presses at its event and stays down while the following
 *  cells keep saying 3; the first cell that does not releases it, at once
 *  when it is 0 and at the event after when it is 2. The last event clears
 *  every hold, so a run of 3s to the end releases there. */
export function decodeDks(byte: number): DksAction {
  const cells = [0, 1, 2, 3].map((i) => (byte >> (2 * i)) & 3);
  for (let i = 0; i < 4; i++) {
    const v = cells[i];
    if (v === 1) return { start: i, end: i };
    if (v === 2) return { start: i, end: Math.min(i + 1, 3) };
    if (v === 3) {
      let j = i;
      while (j < 4 && cells[j] === 3) j++;
      const end = j < 4 && cells[j] === 2 ? j + 1 : j;
      return { start: i, end: Math.min(end, 3) };
    }
  }
  return { start: null, end: 0 };
}

/** The shortest encoding of an action: a tap is one 1, a hold is 3s ending
 *  in a 2 at the cell before the releasing event. */
export function encodeDks(a: DksAction): number {
  if (a.start === null) return 0;
  if (a.end <= a.start) return 1 << (2 * a.start);
  let byte = 0;
  for (let i = a.start; i < a.end - 1; i++) byte |= 3 << (2 * i);
  byte |= 2 << (2 * (a.end - 1));
  return byte;
}
