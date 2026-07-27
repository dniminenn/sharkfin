// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import KeyboardView from "@/components/KeyboardView";
import { useBoardLayout, type LayoutKey } from "@/lib/layout-loader";
import { GROUPS, entryLabel, usageLabel, type Assignable } from "@/lib/hid-usages";
import { readKeymap, readFnKeymap, setKey, type ConnectedDevice } from "@/lib/backend";

const PROFILES = [0, 1, 2];

// Every plain-key usage, for the combo pickers.
const COMBO_KEYS: { label: string; usage: number }[] = GROUPS.flatMap((g) =>
  g.items
    .filter((i) => i.entry[0] === 0 && i.entry[2] !== 0)
    .map((i) => ({ label: i.label, usage: i.entry[2] })),
);

function sliceEntries(matrix: number[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (let slot = 0; slot < 128; slot++) {
    m.set(slot, matrix.slice(slot * 4, slot * 4 + 4));
  }
  return m;
}

export default function KeymapPage({ device }: { device: ConnectedDevice | null }) {
  const connected = !!device;
  const layout = useBoardLayout(device);
  const [profile, setProfile] = useState(0);
  const [layer, setLayer] = useState<"base" | "fn">("base");
  const [entries, setEntries] = useState<Map<number, number[]> | null>(null);
  const [selected, setSelected] = useState<LayoutKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [combo, setCombo] = useState<{ main: number; extraA: number; extraB: number }>({
    main: 0,
    extraA: 0,
    extraB: 0,
  });

  // Defaults come from the layout; a synthesized grid has none, and the Fn
  // layer's factory state isn't in the layout files either.
  const defaults = useMemo(() => {
    const m = new Map<number, number[]>();
    if (layout.grid || layer === "fn") return m;
    for (const k of layout.keys) {
      if (k.matrixIndex !== null) m.set(k.matrixIndex, k.matrixEntry);
    }
    return m;
  }, [layout, layer]);

  const load = useCallback(async (prof: number, lay: "base" | "fn") => {
    setEntries(null);
    try {
      const matrix = lay === "fn" ? await readFnKeymap(prof) : await readKeymap(prof);
      setEntries(sliceEntries(matrix));
    } catch (e) {
      toast.error(`Failed to read keymap: ${e}`);
    }
  }, []);

  useEffect(() => {
    if (connected) load(profile, layer);
    else setEntries(null);
  }, [connected, profile, layer, load]);

  const modified = useMemo(() => {
    const s = new Set<number>();
    if (!entries) return s;
    for (const [slot, def] of defaults) {
      const cur = entries.get(slot);
      if (cur && !def.every((b, i) => b === cur[i])) s.add(slot);
    }
    return s;
  }, [entries, defaults]);

  const assign = async (a: Assignable) => {
    if (!selected || !entries) return;
    const slot = selected.matrixIndex!;
    setBusy(true);
    try {
      await setKey(profile, slot, a.entry, layer === "fn");
      setEntries((prev) => {
        const next = new Map(prev);
        next.set(slot, [...a.entry]);
        return next;
      });
      toast.success(`${selected.text ?? selected.code} → ${a.label}`);
    } catch (e) {
      toast.error(`Write failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const assignCombo = () => {
    if (!combo.main) return;
    const entry: Assignable["entry"] = [0, combo.extraA, combo.main, combo.extraB];
    const label = [combo.extraA, combo.main, combo.extraB]
      .filter(Boolean)
      .map(usageLabel)
      .join("+");
    return assign({ label, entry });
  };

  const resetKey = async () => {
    if (!selected) return;
    const def = defaults.get(selected.matrixIndex!);
    if (def) await assign({ label: "default", entry: def as Assignable["entry"] });
  };

  if (!connected) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Connect your keyboard by USB cable to edit the keymap.
      </div>
    );
  }

  const selectedEntry = selected ? entries?.get(selected.matrixIndex!) : undefined;

  const comboSelect = (
    field: "main" | "extraA" | "extraB",
    placeholder: string,
    optional: boolean,
  ) => (
    <Select
      value={combo[field] ? String(combo[field]) : ""}
      onValueChange={(v) => setCombo((c) => ({ ...c, [field]: Number(v) }))}
    >
      <SelectTrigger className="w-32">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {optional && <SelectItem value="0">none</SelectItem>}
        {COMBO_KEYS.map((k) => (
          <SelectItem key={`${field}-${k.usage}`} value={String(k.usage)}>
            {k.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Keys</h1>
          <p className="text-sm text-muted-foreground">
            Click a key, then pick its new function. Writes are instant.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border p-0.5">
            {(["base", "fn"] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLayer(l)}
                className={cn(
                  "rounded px-3 py-1 text-sm transition-colors",
                  layer === l ? "bg-primary/10 font-medium" : "text-muted-foreground",
                )}
              >
                {l === "base" ? "Base" : "Fn layer"}
              </button>
            ))}
          </div>
          <span className="text-sm text-muted-foreground">Profile</span>
          <Select
            value={String(profile)}
            onValueChange={(v) => setProfile(Number(v))}
          >
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROFILES.map((p) => (
                <SelectItem key={p} value={String(p)}>
                  {p + 1}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {layout.grid && (
        <p className="text-xs text-muted-foreground">
          No layout data for this board yet, so here are its 128 matrix slots as a
          grid. Everything is still editable; labels come from what the board
          reports.
        </p>
      )}

      {!entries ? (
        <div className="flex h-64 items-center justify-center text-muted-foreground">
          Reading keymap…
        </div>
      ) : (
        <>
          <KeyboardView
            layout={layout}
            selected={selected?.matrixIndex ?? null}
            entries={entries}
            modified={modified}
            labelFor={(k, entry) =>
              entry ? entryLabel(entry) : (k.text ?? k.code)
            }
            onSelect={setSelected}
          />

          {defaults.size > 0 && (
            <p className="text-center text-xs text-muted-foreground">
              <span className="mr-1 inline-block h-[0.5em] w-[0.5em] rounded-full bg-(--ring) align-middle" />
              marks a key that differs from this board's factory default.
            </p>
          )}

          <Card className={cn(!selected && "opacity-60")}>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">
                {selected
                  ? `Assign: ${selected.text ?? selected.code}${layer === "fn" ? " (Fn layer)" : ""}`
                  : "Select a key above"}
                {selected && selectedEntry && (
                  <Badge variant="outline" className="ml-2">
                    now: {entryLabel(selectedEntry)}
                  </Badge>
                )}
              </CardTitle>
              {selected && defaults.size > 0 && (
                <Button size="sm" variant="outline" onClick={resetKey} disabled={busy}>
                  Reset to default
                </Button>
              )}
            </CardHeader>
            {selected && (
              <CardContent>
                <ScrollArea className="h-56">
                  <div className="space-y-3 pr-3">
                    {GROUPS.map((g) => (
                      <div key={g.name}>
                        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {g.name}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {g.items.map((item) => (
                            <button
                              key={g.name + item.label}
                              disabled={busy}
                              onClick={() => assign(item)}
                              className="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-50"
                            >
                              {item.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                    <div>
                      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Combo: up to three keys on one press
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {comboSelect("main", "key", false)}
                        <span className="text-xs text-muted-foreground">+</span>
                        {comboSelect("extraA", "second", true)}
                        <span className="text-xs text-muted-foreground">+</span>
                        {comboSelect("extraB", "third", true)}
                        <Button
                          size="sm"
                          disabled={busy || !combo.main}
                          onClick={assignCombo}
                        >
                          Apply combo
                        </Button>
                      </div>
                    </div>
                  </div>
                </ScrollArea>
              </CardContent>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
