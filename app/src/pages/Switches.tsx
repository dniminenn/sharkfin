// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Magnetic-switch settings: actuation and release point, rapid trigger and
// its sensitivities, bottom dead zone, and the per-key kinds (dynamic
// keystroke, mod-tap, toggle, snap) with the keymap sub-layers they act on.
// Read where the board has columns; written only where the board's own
// firmware has been read (registry gate). yc500 boards below firmware 2.00
// take one board-wide record instead and report nothing back. Each write is
// a flash save on the board, so the page applies on a button, never on a
// slider move.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { t } from "@/lib/i18n";
import { GROUPS, entryLabel } from "@/lib/hid-usages";
import { decodeDks, encodeDks, type DksAction } from "@/lib/dks";
import { useBoardLayout, type LayoutKey } from "@/lib/layout-loader";
import { useBoardProfile } from "@/lib/use-profile";
import KeyboardView from "@/components/KeyboardView";
import Waiting from "@/components/Waiting";
import {
  getSwitches,
  getSwitchPreset,
  readKeymapLayer,
  setKeyLayer,
  setSwitchesAll,
  setSwitchesGlobal,
  setSwitchKey,
  setSwitchKeys,
  setSwitchPreset,
  type ConnectedDevice,
  type KeySwitch,
  type SwitchSettings,
  type TravelRange,
} from "@/lib/backend";

/** The backend decides (DeviceSpec::hall_reads and friends); this only reads
 *  its verdict. */
export const hasSwitches = (d: ConnectedDevice | null): boolean =>
  !!d && d.switches !== "none";

export const canWriteSwitches = (d: ConnectedDevice): boolean =>
  d.switches === "write" || d.switches === "global";

const KIND_PLAIN = 0;
const KIND_DKS = 2;
const KIND_MOD_TAP = 3;
const KIND_TOGGLE = 4;
const KIND_TOGGLE_REPEAT = 5;
const KIND_SNAP = 7;
const NO_PARTNER = 255;
const YC500_SLOTS = 126;

const KINDS: { value: number; label: () => string }[] = [
  { value: KIND_PLAIN, label: () => t("Plain") },
  { value: KIND_DKS, label: () => t("Dynamic keystroke") },
  { value: KIND_MOD_TAP, label: () => t("Mod-tap") },
  { value: KIND_TOGGLE, label: () => t("Toggle") },
  { value: KIND_TOGGLE_REPEAT, label: () => t("Toggle, repeating") },
  { value: KIND_SNAP, label: () => t("Snap") },
];

const PRESETS: { value: number; label: () => string }[] = [
  { value: 0, label: () => t("Comfort") },
  { value: 1, label: () => t("Sensitive") },
  { value: 2, label: () => t("Gaming") },
  { value: 3, label: () => t("Custom") },
];

/** The four travel events a dynamic-keystroke action can hang on, in the
 *  order the firmware walks them. */
const EVENTS = (): string[] => [
  t("press past the first point"),
  t("press past the second point"),
  t("release past the second point"),
  t("release past the first point"),
];

/** What the yc500 firmware applies with no saved block; shown on boards
 *  that cannot report their settings. */
export const yc500Default = (slot: number): KeySwitch => ({
  slot,
  kind: KIND_PLAIN,
  rapidTrigger: false,
  travel: 1.9,
  lift: 2.9,
  rtPress: 0.3,
  rtLift: 0.3,
  deadBottom: 0.6,
  dksStart: 0.4,
  dksActions: [0, 0, 0, 0],
  mtTimeMs: 300,
  snapPartner: NO_PARTNER,
});

const range = (
  r: TravelRange | undefined | null,
  min: number,
  max: number,
  step: number,
  unit: number,
) => ({
  min: Math.max(r?.min ?? min, unit),
  max: r?.max ?? max,
  step: Math.max(r?.step ?? step, unit),
});

const rangesFor = (d: ConnectedDevice, unit: number) => ({
  travel: range(d.spec.travel?.travel, 0.1, 3.3, 0.01, unit),
  firePress: range(d.spec.travel?.firePress, 0.01, 2.0, 0.01, unit),
  fireLift: range(d.spec.travel?.fireLift, 0.01, 2.0, 0.01, unit),
  deadzone: { ...range(d.spec.travel?.deadzone, 0, 1.0, 0.1, unit), min: 0 },
});

const ENTRY_NONE = "0,0,0,0";
const entryKey = (e: number[]) => e.join(",");
const keyFromEntry = (s: string) => s.split(",").map(Number);

function Row({
  label,
  value,
  r,
  unit,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  r: { min: number; max: number; step: number };
  unit: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const decimals = unit >= 0.1 ? 1 : 2;
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm">
        <Label>{label}</Label>
        <span className="text-muted-foreground">{value.toFixed(decimals)} mm</span>
      </div>
      <Slider
        min={r.min}
        max={r.max}
        step={r.step}
        value={[value]}
        disabled={disabled}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  );
}

/** A keymap entry picker over the assignable groups. An entry the groups
 *  do not know (a macro, a combo) stays selectable as itself. */
function KeySelect({
  value,
  onChange,
  disabled,
}: {
  value: number[];
  onChange: (entry: number[]) => void;
  disabled?: boolean;
}) {
  const current = entryKey(value);
  const known =
    current === ENTRY_NONE ||
    GROUPS.some((g) => g.items.some((i) => entryKey(i.entry) === current));
  return (
    <Select value={current} onValueChange={(v) => onChange(keyFromEntry(v))} disabled={disabled}>
      <SelectTrigger className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ENTRY_NONE}>{t("nothing")}</SelectItem>
        {!known && <SelectItem value={current}>{entryLabel(value)}</SelectItem>}
        {GROUPS.map((g) => (
          <SelectGroup key={g.name}>
            <SelectLabel>{g.name}</SelectLabel>
            {g.items.map((item) => (
              <SelectItem key={g.name + item.label} value={entryKey(item.entry)}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function PlainRows({
  value,
  ranges,
  unit,
  onChange,
  travelLabel,
}: {
  value: KeySwitch;
  ranges: ReturnType<typeof rangesFor>;
  unit: number;
  onChange: (k: KeySwitch) => void;
  travelLabel?: string;
}) {
  return (
    <>
      <Row
        label={travelLabel ?? t("Actuation point")}
        value={value.travel}
        r={ranges.travel}
        unit={unit}
        onChange={(v) => onChange({ ...value, travel: v })}
      />
      <Row
        label={t("Release point")}
        value={value.lift}
        r={ranges.travel}
        unit={unit}
        onChange={(v) => onChange({ ...value, lift: v })}
      />
      <div className="flex items-center justify-between text-sm">
        <div>
          <Label>{t("Rapid trigger")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("Re-arms the key on the way up instead of at a fixed point.")}
          </p>
        </div>
        <Switch
          checked={value.rapidTrigger}
          onCheckedChange={(v) => onChange({ ...value, rapidTrigger: v })}
        />
      </div>
      <Row
        label={t("Rapid trigger press")}
        value={value.rtPress}
        r={ranges.firePress}
        unit={unit}
        disabled={!value.rapidTrigger}
        onChange={(v) => onChange({ ...value, rtPress: v })}
      />
      <Row
        label={t("Rapid trigger release")}
        value={value.rtLift}
        r={ranges.fireLift}
        unit={unit}
        disabled={!value.rapidTrigger}
        onChange={(v) => onChange({ ...value, rtLift: v })}
      />
      <Row
        label={t("Bottom dead zone")}
        value={value.deadBottom}
        r={ranges.deadzone}
        unit={unit}
        onChange={(v) => onChange({ ...value, deadBottom: v })}
      />
    </>
  );
}

function DksRows({
  value,
  entries,
  ranges,
  unit,
  onChange,
  onEntry,
}: {
  value: KeySwitch;
  entries: number[][];
  ranges: ReturnType<typeof rangesFor>;
  unit: number;
  onChange: (k: KeySwitch) => void;
  onEntry: (layer: number, entry: number[]) => void;
}) {
  const events = EVENTS();
  const setAction = (layer: number, a: DksAction) => {
    const actions = [...value.dksActions];
    actions[layer] = encodeDks(a);
    onChange({ ...value, dksActions: actions });
  };
  return (
    <div className="space-y-3">
      <Row
        label={t("First point")}
        value={value.dksStart}
        r={ranges.travel}
        unit={unit}
        onChange={(v) => onChange({ ...value, dksStart: v })}
      />
      <p className="text-xs text-muted-foreground">
        {t(
          "The actuation point above is the second point. Each action below is a key, pressed at one event and released at another, or tapped.",
        )}
      </p>
      {[0, 1, 2, 3].map((layer) => {
        const a = decodeDks(value.dksActions[layer] ?? 0);
        return (
          <div key={layer} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-16 text-muted-foreground">{t("Action {n}", { n: layer + 1 })}</span>
            <KeySelect value={entries[layer] ?? [0, 0, 0, 0]} onChange={(e) => onEntry(layer, e)} />
            <Select
              value={a.start === null ? "none" : String(a.start)}
              onValueChange={(v) =>
                setAction(
                  layer,
                  v === "none"
                    ? { start: null, end: 0 }
                    : { start: Number(v), end: Math.max(Number(v), a.end) },
                )
              }
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("never")}</SelectItem>
                {events.map((e, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {t("from {event}", { event: e })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {a.start !== null && (
              <Select
                value={String(a.end)}
                onValueChange={(v) => setAction(layer, { start: a.start, end: Number(v) })}
              >
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={String(a.start)}>{t("tap")}</SelectItem>
                  {events.map((e, i) =>
                    i > a.start! ? (
                      <SelectItem key={i} value={String(i)}>
                        {t("held until {event}", { event: e })}
                      </SelectItem>
                    ) : null,
                  )}
                </SelectContent>
              </Select>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function SwitchesPage({ device }: { device: ConnectedDevice | null }) {
  const { layout, resolving } = useBoardLayout(device);
  const { profile } = useBoardProfile(device);
  const [settings, setSettings] = useState<SwitchSettings | null>(null);
  const [preset, setPreset] = useState<number | null>(null);
  const [layers, setLayers] = useState<number[][] | null>(null);
  const [selected, setSelected] = useState<LayoutKey | null>(null);
  const [draftAll, setDraftAll] = useState<KeySwitch | null>(null);
  const [draftKey, setDraftKey] = useState<KeySwitch | null>(null);
  const [draftEntries, setDraftEntries] = useState<number[][]>([]);
  const [busy, setBusy] = useState(false);

  const access = device?.switches ?? "none";
  const global = access === "global";

  const load = useCallback(async () => {
    if (!device || access === "none") {
      setSettings(null);
      return;
    }
    try {
      const s: SwitchSettings = global
        ? {
            format: "yc500",
            unitMm: 0.1,
            keys: Array.from({ length: YC500_SLOTS }, (_, i) => yc500Default(i)),
          }
        : await getSwitches();
      setSettings(s);
      // The "all keys" draft starts from the most common key, so one click
      // without changes writes back what the board already has.
      const plain = s.keys.filter((k) => k.kind === KIND_PLAIN);
      setDraftAll(plain[0] ?? s.keys[0] ?? null);
      if (s.format === "yc500") setPreset(await getSwitchPreset());
    } catch (e) {
      toast.error(t("Could not read switch settings: {e}", { e: String(e) }));
    }
  }, [device, access, global]);

  const loadLayers = useCallback(async () => {
    if (!device || access === "none") {
      setLayers(null);
      return;
    }
    try {
      const out: number[][] = [];
      for (let i = 0; i < 4; i++) out.push(await readKeymapLayer(profile, i));
      setLayers(out);
    } catch (e) {
      toast.error(t("Could not read the keymap sub-layers: {e}", { e: String(e) }));
    }
  }, [device, access, profile]);

  useEffect(() => {
    load();
    setSelected(null);
    setDraftKey(null);
  }, [load]);

  useEffect(() => {
    loadLayers();
  }, [loadLayers]);

  useEffect(() => {
    if (!selected || !settings) return;
    const k = settings.keys.find((k) => k.slot === selected.matrixIndex);
    setDraftKey(k ? { ...k, dksActions: [...k.dksActions] } : null);
    const slot = selected.matrixIndex ?? 0;
    setDraftEntries(
      [0, 1, 2, 3].map((i) => layers?.[i]?.slice(slot * 4, slot * 4 + 4) ?? [0, 0, 0, 0]),
    );
  }, [selected, settings, layers]);

  if (!device) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {t("Connect your keyboard.")}
      </div>
    );
  }
  if (access === "none") {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {t("This board has no magnetic switches.")}
      </div>
    );
  }
  if (!settings || resolving) {
    return (
      <div className="flex h-full items-center justify-center">
        <Waiting label={t("Reading switch settings…")} />
      </div>
    );
  }

  const writable = canWriteSwitches(device);
  const unit = settings.unitMm;
  const ranges = rangesFor(device, unit);
  const bySlot = new Map(settings.keys.map((k) => [k.slot, k]));
  const keysBySlot = new Map(
    layout.keys.filter((k) => k.matrixIndex !== null).map((k) => [k.matrixIndex!, k]),
  );
  const nameOf = (slot: number) => {
    const k = keysBySlot.get(slot);
    return k ? (k.text ?? k.code) : t("slot {n}", { n: slot });
  };

  /** Local copy after a global write: the board cannot be re-read. */
  const remember = (keys: KeySwitch[]) => {
    const next = new Map(bySlot);
    for (const k of keys) next.set(k.slot, k);
    setSettings({ ...settings, keys: [...next.values()].sort((a, b) => a.slot - b.slot) });
    setPreset(3);
  };

  const applyAll = async () => {
    if (!draftAll) return;
    setBusy(true);
    try {
      if (global) {
        await setSwitchesGlobal({ ...draftAll, kind: KIND_PLAIN }, true);
        remember(
          settings.keys.map((k) => ({
            ...k,
            travel: draftAll.travel,
            lift: draftAll.lift,
            rapidTrigger: k.kind === KIND_PLAIN || k.kind === KIND_DKS ? draftAll.rapidTrigger : k.rapidTrigger,
            rtPress: draftAll.rtPress,
            rtLift: draftAll.rtLift,
            deadBottom: draftAll.deadBottom,
          })),
        );
      } else {
        await setSwitchesAll(
          draftAll,
          settings.keys.map((k) => k.kind),
        );
        await load();
      }
      toast.success(t("Switch settings written to every key."));
    } catch (e) {
      toast.error(t("Write failed: {e}", { e: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const layersFor = (kind: number) =>
    kind === KIND_DKS ? [0, 1, 2, 3] : kind === KIND_MOD_TAP ? [0, 1] : kind === KIND_TOGGLE || kind === KIND_TOGGLE_REPEAT ? [0] : [];

  const applyKey = async () => {
    if (!draftKey) return;
    if (draftKey.kind === KIND_SNAP && (draftKey.snapPartner === NO_PARTNER || draftKey.snapPartner === draftKey.slot)) {
      toast.error(t("Pick the snap partner first."));
      return;
    }
    setBusy(true);
    try {
      const slot = draftKey.slot;
      for (const i of layersFor(draftKey.kind)) {
        const now = layers?.[i]?.slice(slot * 4, slot * 4 + 4) ?? [0, 0, 0, 0];
        const want = draftEntries[i] ?? [0, 0, 0, 0];
        if (entryKey(now) !== entryKey(want)) await setKeyLayer(profile, i, slot, want);
      }
      if (global) {
        await setSwitchesGlobal(draftKey, false);
        remember([draftKey]);
      } else if (draftKey.kind === KIND_SNAP) {
        const partner = bySlot.get(draftKey.snapPartner) ?? yc500Default(draftKey.snapPartner);
        await setSwitchKeys([draftKey, { ...partner, kind: KIND_SNAP, snapPartner: slot }]);
        await load();
      } else {
        await setSwitchKey(draftKey);
        await load();
      }
      await loadLayers();
      toast.success(t("Switch settings written."));
    } catch (e) {
      toast.error(t("Write failed: {e}", { e: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const choosePreset = async (p: number) => {
    setBusy(true);
    try {
      await setSwitchPreset(p);
      setPreset(p);
      toast.success(t("Preset written."));
    } catch (e) {
      toast.error(t("Write failed: {e}", { e: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const setEntry = (layer: number, entry: number[]) =>
    setDraftEntries((prev) => {
      const next = [...prev];
      next[layer] = entry;
      return next;
    });

  const kindHint = (kind: number) => {
    switch (kind) {
      case KIND_DKS:
        return t("Up to four actions, each tied to how far the key travels.");
      case KIND_MOD_TAP:
        return t("Held past the time, it is the first key; released before, it taps the second.");
      case KIND_TOGGLE:
        return t("A tap latches the key down; the next tap releases it. Holding it works as a plain key.");
      case KIND_TOGGLE_REPEAT:
        return t("Like toggle, but the latched key repeats.");
      case KIND_SNAP:
        return t("Pressing this key releases its partner while both are held. Both keys are written.");
      default:
        return t("This key alone.");
    }
  };

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t("Switches")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "How far each key travels before it fires, and whether it re-arms on the way up. Values are millimetres, as the board stores them.",
          )}
        </p>
        {!writable && (
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "Read-only here: sharkfin has not read this board's firmware for its switch settings yet.",
            )}
          </p>
        )}
        {global && (
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "This board's firmware takes switch settings but cannot report them. The values shown are its defaults until you write.",
            )}
          </p>
        )}
      </div>

      {settings.format === "yc500" && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Label>{t("Preset")}</Label>
          <Select
            value={preset === null ? "" : String(preset)}
            onValueChange={(v) => choosePreset(Number(v))}
            disabled={!writable || busy}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder={t("unknown")} />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((p) => (
                <SelectItem key={p.value} value={String(p.value)}>
                  {p.label()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {t("The built-in presets ignore the per-key values. Writing a key switches the board to Custom.")}
          </span>
        </div>
      )}

      <KeyboardView
        layout={layout}
        selected={selected?.matrixIndex ?? null}
        entries={new Map()}
        modified={new Set(settings.keys.filter((k) => k.kind !== KIND_PLAIN).map((k) => k.slot))}
        labelFor={(k) => {
          const s = k.matrixIndex === null ? undefined : bySlot.get(k.matrixIndex);
          if (!s) return k.text ?? k.code;
          const kind = KINDS.find((x) => x.value === s.kind);
          return s.kind === KIND_PLAIN
            ? `${s.travel.toFixed(unit >= 0.1 ? 1 : 2)}${s.rapidTrigger ? " RT" : ""}`
            : (kind?.label() ?? String(s.kind));
        }}
        onSelect={setSelected}
      />
      <p className="text-center text-xs text-muted-foreground">
        {t(
          "Each key shows its actuation point, or its kind when it is not a plain key. Click a key to edit it alone.",
        )}
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        {draftAll && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("All keys")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">
                {t("Written to every key at once. Keys with a kind keep it.")}
              </p>
              <PlainRows value={draftAll} ranges={ranges} unit={unit} onChange={setDraftAll} />
              <Button size="sm" onClick={applyAll} disabled={!writable || busy}>
                {busy ? t("Writing. Leave the keyboard plugged in.") : t("Apply to all keys")}
              </Button>
            </CardContent>
          </Card>
        )}
        {draftKey && selected && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{selected.text ?? selected.code}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between text-sm">
                <Label>{t("Kind")}</Label>
                <Select
                  value={String(draftKey.kind)}
                  onValueChange={(v) => setDraftKey({ ...draftKey, kind: Number(v) })}
                  disabled={!writable}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KINDS.map((k) => (
                      <SelectItem key={k.value} value={String(k.value)}>
                        {k.label()}
                      </SelectItem>
                    ))}
                    {!KINDS.some((k) => k.value === draftKey.kind) && (
                      <SelectItem value={String(draftKey.kind)}>
                        {t("Unknown kind {n}", { n: draftKey.kind })}
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">{kindHint(draftKey.kind)}</p>
              <PlainRows
                value={draftKey}
                ranges={ranges}
                unit={unit}
                onChange={setDraftKey}
                travelLabel={draftKey.kind === KIND_DKS ? t("Second point") : undefined}
              />
              {draftKey.kind === KIND_DKS && (
                <DksRows
                  value={draftKey}
                  entries={draftEntries}
                  ranges={ranges}
                  unit={unit}
                  onChange={setDraftKey}
                  onEntry={setEntry}
                />
              )}
              {draftKey.kind === KIND_MOD_TAP && (
                <div className="space-y-3 text-sm">
                  <div className="flex items-center justify-between">
                    <Label>{t("Held")}</Label>
                    <KeySelect value={draftEntries[0] ?? [0, 0, 0, 0]} onChange={(e) => setEntry(0, e)} />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label>{t("Tapped")}</Label>
                    <KeySelect value={draftEntries[1] ?? [0, 0, 0, 0]} onChange={(e) => setEntry(1, e)} />
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <Label>{t("Hold time")}</Label>
                      <span className="text-muted-foreground">{draftKey.mtTimeMs} ms</span>
                    </div>
                    <Slider
                      min={10}
                      max={2550}
                      step={10}
                      value={[draftKey.mtTimeMs]}
                      onValueChange={([v]) => setDraftKey({ ...draftKey, mtTimeMs: v })}
                    />
                  </div>
                </div>
              )}
              {(draftKey.kind === KIND_TOGGLE || draftKey.kind === KIND_TOGGLE_REPEAT) && (
                <div className="flex items-center justify-between text-sm">
                  <Label>{t("Key")}</Label>
                  <KeySelect value={draftEntries[0] ?? [0, 0, 0, 0]} onChange={(e) => setEntry(0, e)} />
                </div>
              )}
              {draftKey.kind === KIND_SNAP && (
                <div className="flex items-center justify-between text-sm">
                  <Label>{t("Partner")}</Label>
                  <Select
                    value={draftKey.snapPartner === NO_PARTNER ? "" : String(draftKey.snapPartner)}
                    onValueChange={(v) => setDraftKey({ ...draftKey, snapPartner: Number(v) })}
                  >
                    <SelectTrigger className="w-48">
                      <SelectValue placeholder={t("pick a key")} />
                    </SelectTrigger>
                    <SelectContent>
                      {[...keysBySlot.keys()]
                        .filter((s) => s !== draftKey.slot && bySlot.has(s))
                        .sort((a, b) => a - b)
                        .map((s) => (
                          <SelectItem key={s} value={String(s)}>
                            {nameOf(s)}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <Button size="sm" onClick={applyKey} disabled={!writable || busy}>
                {busy ? t("Writing. Leave the keyboard plugged in.") : t("Apply to this key")}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
