// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// What a key can become, opened on the key itself. Search first: most
// people know the name of what they want. Recents come next, then every
// group, then combos. Writes go straight to the board.
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { t } from "@/lib/i18n";
import { CODE_TO_USAGE, GROUPS, entryLabel, usageLabel, type Assignable } from "@/lib/hid-usages";

const RECENTS_KEY = "sharkfin.recent-keys";
const RECENTS = 8;

const COMBO_KEYS: { label: string; usage: number }[] = GROUPS.flatMap((g) =>
  g.items
    .filter((i) => i.entry[0] === 0 && i.entry[2] !== 0)
    .map((i) => ({ label: i.label, usage: i.entry[2] })),
);

function readRecents(): Assignable[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? (JSON.parse(raw) as Assignable[]) : [];
  } catch {
    return [];
  }
}

const CODE_OF: Record<number, string> = Object.fromEntries(
  Object.entries(CODE_TO_USAGE).map(([c, u]) => [u, c.toLowerCase()]),
);

/** How well a query names a key: the label starting with it beats the
 *  label containing it, which beats the key's code name, which beats its
 *  group. "cap" must find Caps before Escape. */
export function matchRank(q: string, label: string, code?: string, group?: string): number {
  const l = label.toLowerCase();
  if (l.startsWith(q)) return 0;
  if (l.includes(q)) return 1;
  if (code?.startsWith(q)) return 2;
  if (code?.includes(q)) return 3;
  if (group?.toLowerCase().includes(q)) return 4;
  return -1;
}

/** Everything the query names, best match first. "left" finds the left
 *  arrow, "page" both page keys, "media" the whole group. */
export function searchAssignables(query: string): Assignable[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: { rank: number; item: Assignable }[] = [];
  for (const g of GROUPS)
    for (const item of g.items) {
      const code = item.entry[0] === 0 ? CODE_OF[item.entry[2]] : undefined;
      const rank = matchRank(q, item.label, code, g.name);
      if (rank >= 0) out.push({ rank, item });
    }
  out.sort((a, b) => a.rank - b.rank);
  return out.slice(0, 48).map((o) => o.item);
}

/** A key that is not a character: pressing it names itself. Characters
 *  are typed into the search, and the keys that edit it stay editing. */
export function directUsage(e: React.KeyboardEvent): number | undefined {
  if (e.key.length === 1 || e.ctrlKey || e.metaKey || e.altKey) return undefined;
  if (/^(Shift|Control|Alt|Meta|CapsLock|Tab|Enter|Escape|Backspace|Arrow(Left|Right|Up|Down)|Dead|Compose|Unidentified)$/.test(e.key))
    return undefined;
  return CODE_TO_USAGE[e.code];
}

export function rememberRecent(a: Assignable) {
  try {
    const next = [a, ...readRecents().filter((r) => r.label !== a.label)].slice(0, RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // A convenience only.
  }
}

interface Props {
  /** The key's own legend. */
  name: string;
  /** What is being typed on the cap; the list follows it. */
  query: string;
  current: number[] | undefined;
  fnLayer: boolean;
  canReset: boolean;
  disabled: boolean;
  onAssign: (a: Assignable) => void;
  onReset: () => void;
}

export default function KeyPicker({
  name,
  query,
  current,
  fnLayer,
  canReset,
  disabled,
  onAssign,
  onReset,
}: Props) {
  const [combo, setCombo] = useState({ main: 0, extraA: 0, extraB: 0 });
  const recents = useMemo(readRecents, []);

  const q = query.trim().toLowerCase();
  const hits = useMemo(() => searchAssignables(query), [query]);

  const isCurrent = (a: Assignable) => !!current && a.entry.every((b, i) => b === current[i]);

  const chip = (item: Assignable, key: string, first = false) => (
    <button
      key={key}
      disabled={disabled}
      onClick={() => onAssign(item)}
      data-on={isCurrent(item)}
      data-first={first}
      className="rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-50 data-[first=true]:ring-1 data-[first=true]:ring-(--ring) data-[on=true]:bg-primary data-[on=true]:text-primary-foreground"
    >
      {item.label}
    </button>
  );

  const applyCombo = () => {
    if (!combo.main) return;
    const entry: Assignable["entry"] = [0, combo.extraA, combo.main, combo.extraB];
    const label = [combo.extraA, combo.main, combo.extraB]
      .filter(Boolean)
      .map(usageLabel)
      .join("+");
    onAssign({ label, entry });
  };

  const comboSelect = (field: "main" | "extraA" | "extraB", placeholder: string, optional: boolean) => (
    <Select
      value={combo[field] ? String(combo[field]) : ""}
      onValueChange={(v) => setCombo((c) => ({ ...c, [field]: Number(v) }))}
    >
      <SelectTrigger size="sm" className="w-24">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {optional && <SelectItem value="0">{t("none")}</SelectItem>}
        {COMBO_KEYS.map((k) => (
          <SelectItem key={`${field}-${k.usage}`} value={String(k.usage)}>
            {k.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="flex w-80 flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-sm font-semibold">{name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {current
              ? fnLayer
                ? t("Fn layer, now {label}", { label: entryLabel(current, true) })
                : t("now {label}", { label: entryLabel(current, false) })
              : fnLayer
                ? t("Fn layer")
                : ""}
          </div>
        </div>
        {canReset && (
          <Button size="xs" variant="ghost" disabled={disabled} onClick={onReset}>
            {t("Reset")}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {q
          ? t("Enter takes the outlined match.")
          : t("Type on the key, or press the key you want on another keyboard.")}
      </p>
      <div className="max-h-72 overflow-y-auto pr-1">
        {q ? (
          hits.length ? (
            <div className="flex flex-wrap gap-1">
              {hits.map((item, i) => chip(item, `hit-${item.label}`, i === 0))}
            </div>
          ) : (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              {t("Nothing called that. Try a letter, a key name like PgUp, or a group like Media.")}
            </p>
          )
        ) : (
          <div className="space-y-3">
            {recents.length > 0 && (
              <div>
                <div className="mb-1 px-1 text-xs text-muted-foreground">{t("Recent")}</div>
                <div className="flex flex-wrap gap-1">
                  {recents.map((r) => chip(r, `recent-${r.label}`))}
                </div>
              </div>
            )}
            {GROUPS.map((g) => (
              <div key={g.name}>
                <div className="mb-1 px-1 text-xs text-muted-foreground">{t(g.name)}</div>
                <div className="flex flex-wrap gap-1">
                  {g.items.map((item) => chip(item, `${g.name}-${item.label}`))}
                </div>
              </div>
            ))}
            <div>
              <div className="mb-1 px-1 text-xs text-muted-foreground">
                {t("Combo, up to three keys on one press")}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {comboSelect("main", t("key"), false)}
                <span className="text-xs text-muted-foreground">+</span>
                {comboSelect("extraA", t("second"), true)}
                <span className="text-xs text-muted-foreground">+</span>
                {comboSelect("extraB", t("third"), true)}
                <Button size="xs" disabled={disabled || !combo.main} onClick={applyCombo}>
                  {t("Apply")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
