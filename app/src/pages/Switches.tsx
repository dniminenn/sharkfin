// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Magnetic switches. Read where columns exist; write only where firmware
// has been read (registry gate). yc500 below 2.00 takes one board-wide
// record and reports nothing back. Each write is a flash save: button, not
// slider.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PageHeader, Section } from "@/components/Page";
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
  travelRead,
  travelStream,
  type ConnectedDevice,
  type KeySwitch,
  type SwitchSettings,
  type SwitchType,
  type TravelRange,
} from "@/lib/backend";

/** The depth fill's full scale. Boards bottom out near 4 mm. */
const FULL_TRAVEL_MM = 4.0;

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
  switchType: 0,
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
  const decimals = unit >= 0.1 ? 1 : unit >= 0.01 ? 2 : 3;
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

/** The switch model fitted, from the list the vendor offers for the board.
 *  A code the list lacks is what the firmware reports before any is set;
 *  it stays selectable as itself and is written back unchanged. */
function ModelSelect({
  value,
  types,
  onChange,
  disabled,
  keep,
}: {
  value: number | null;
  types: SwitchType[];
  onChange: (code: number | null) => void;
  disabled?: boolean;
  /** Offer leaving each key as it is; `null` selects it. */
  keep?: boolean;
}) {
  const listed = value !== null && types.some((t) => t.code === value);
  return (
    <Select
      value={value === null ? "keep" : String(value)}
      onValueChange={(v) => onChange(v === "keep" ? null : Number(v))}
      disabled={disabled}
    >
      <SelectTrigger className="w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {keep && <SelectItem value="keep">{t("as each key is")}</SelectItem>}
        {value !== null && !listed && (
          <SelectItem value={String(value)}>{t("Unknown model {n}", { n: value })}</SelectItem>
        )}
        {types.map((s) => (
          <SelectItem key={s.code} value={String(s.code)}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The last three seconds of one key's depth, with the actuation and
 *  release points drawn across it. */
function Trace({ values, max, marks }: { values: number[]; max: number; marks: number[] }) {
  const w = 240;
  const h = 48;
  const y = (mm: number) => h - Math.min(1, Math.max(0, mm / max)) * h;
  const points = values.map((v, i) => `${(i / 59) * w},${y(v)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-12 w-full" aria-hidden="true">
      {marks.map((m, i) => (
        <line key={i} x1={0} x2={w} y1={y(m)} y2={y(m)} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="3 3" />
      ))}
      {values.length > 1 && <polyline points={points} fill="none" stroke="var(--ring)" strokeWidth={1.5} />}
    </svg>
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
  const [allModel, setAllModel] = useState<number | null>(null);
  const [draftKey, setDraftKey] = useState<KeySwitch | null>(null);
  const [draftEntries, setDraftEntries] = useState<number[][]>([]);
  const [busy, setBusy] = useState(false);

  const access = device?.switches ?? "none";
  const global = access === "global";
  // The scan replaces this object every few seconds, and on a receiver link
  // its battery percent moves with it. Reload on the board, not the object,
  // or every edit in progress is thrown away.
  const board = device ? `${device.spec.id}:${device.path}` : null;

  const load = useCallback(async () => {
    if (!board || access === "none") {
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
  }, [board, access, global]);

  const loadLayers = useCallback(async () => {
    if (!board || access === "none") {
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
  }, [board, access, profile]);

  useEffect(() => {
    load();
    setSelected(null);
    setDraftKey(null);
    setAllModel(null);
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

  // Live travel: the board streams each key's depth by cable, gen2 only.
  // Off again when the toggle, the page or the board goes.
  const [live, setLive] = useState(false);
  const [depth, setDepth] = useState<number[] | null>(null);
  useEffect(() => {
    if (!device) setLive(false);
  }, [device]);
  useEffect(() => {
    if (!live) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    travelStream(true)
      .then(() => {
        if (cancelled) return;
        timer = setInterval(
          () => travelRead().then((d) => onSampleRef.current(d)).catch(() => {}),
          50,
        );
      })
      .catch((e) => {
        toast.error(t("Live travel failed: {e}", { e: String(e) }));
        setLive(false);
      });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      setDepth(null);
      travelStream(false).catch(() => {});
    };
  }, [live]);

  // What the stream is used for beyond the picture: the deepest point each
  // key reached (bottom-out comparison, actuation by feel) and, for the
  // selected key, a short trace and the largest lift that did not let go
  // (a rapid trigger release step the hands actually produce).
  const [peak, setPeak] = useState<number[] | null>(null);
  const [trace, setTrace] = useState<number[]>([]);
  const [maxLift, setMaxLift] = useState(0);
  const selectedSlotRef = useRef<number | null>(null);
  const cycleRef = useRef({ slot: -1, peak: 0, trough: 0, maxLift: 0 });
  const onSampleRef = useRef<(d: number[]) => void>(() => {});
  onSampleRef.current = (d) => {
    setDepth(d);
    setPeak((prev) => {
      const p = prev ? prev.slice() : new Array<number>(d.length).fill(0);
      let changed = !prev;
      for (let i = 0; i < d.length; i++) {
        if (d[i] > (p[i] ?? 0)) {
          p[i] = d[i];
          changed = true;
        }
      }
      return changed ? p : prev;
    });
    const slot = selectedSlotRef.current;
    if (slot === null) return;
    const c = d[slot] ?? 0;
    const cy = cycleRef.current;
    if (cy.slot !== slot) {
      cycleRef.current = { slot, peak: 0, trough: 0, maxLift: 0 };
      setTrace([]);
      setMaxLift(0);
      return;
    }
    if (c === 0) {
      cy.peak = 0;
      cy.trough = 0;
    } else if (c > cy.peak) {
      cy.peak = c;
      cy.trough = c;
    } else if (c < cy.trough) {
      cy.trough = c;
    } else if (c > cy.trough && cy.peak - cy.trough >= 2) {
      // Rising again after a dip that did not reach 0: that dip is a lift.
      cy.maxLift = Math.max(cy.maxLift, cy.peak - cy.trough);
      cy.peak = c;
      cy.trough = c;
      setMaxLift(cy.maxLift);
    }
    setTrace((prev) => (prev.length >= 60 ? [...prev.slice(1), c] : [...prev, c]));
  };
  useEffect(() => {
    selectedSlotRef.current = selected?.matrixIndex ?? null;
  }, [selected]);
  useEffect(() => {
    if (!live) {
      setPeak(null);
      setTrace([]);
      setMaxLift(0);
      cycleRef.current = { slot: -1, peak: 0, trough: 0, maxLift: 0 };
    }
  }, [live]);

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
  const models = device.spec.switchTypes ?? [];
  const unit = settings.unitMm;
  const decimals = unit >= 0.1 ? 1 : unit >= 0.01 ? 2 : 3;
  const ranges = rangesFor(device, unit);
  const canLive = device.link === "usb" && settings.format === "gen2" && !global;
  const depthMap =
    live && depth
      ? new Map<number, number>(
          depth
            .map((c, slot): [number, number] => [slot, Math.min(1, (c * unit) / FULL_TRAVEL_MM)])
            .filter(([, v]) => v > 0),
        )
      : undefined;
  // Bottom-out comparison: once enough keys have been pressed to the bottom,
  // a key whose deepest point is short of the middle one by a tenth is
  // called out. Sensor drift and a badly seated switch both show up here.
  const bottomed = live && peak ? peak.map((c, slot) => [slot, c] as const).filter(([slot, c]) => c > 0 && keysBySlot.has(slot)) : [];
  const bottomMedian = bottomed.length ? [...bottomed].map(([, c]) => c).sort((a, b) => a - b)[Math.floor(bottomed.length / 2)] : 0;
  const shortKeys =
    bottomed.length >= 8
      ? bottomed.filter(([, c]) => c < bottomMedian * 0.9).map(([slot]) => keysBySlot.get(slot)!.text ?? keysBySlot.get(slot)!.code)
      : [];
  const selectedSlot = selected?.matrixIndex ?? null;
  const nowMm = selectedSlot !== null && depth ? (depth[selectedSlot] ?? 0) * unit : 0;
  const peakMm = selectedSlot !== null && peak ? (peak[selectedSlot] ?? 0) * unit : 0;
  const maxLiftMm = maxLift * unit;
  const snap = (r: { min: number; max: number; step: number }, mm: number) =>
    Math.min(r.max, Math.max(r.min, Math.round(mm / r.step) * r.step));
  // What the buttons write: the live figures snapped to the register's
  // range. A board can bottom out past the deepest actuation it accepts.
  const peakSet = snap(ranges.travel, peakMm);
  const liftSet = snap(ranges.fireLift, maxLiftMm);
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
          allModel ?? undefined,
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
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <PageHeader
          title={t("Switches")}
          hint={t(
            "How far each key travels before it fires, and whether it re-arms on the way up. Values are millimetres, as the board stores them.",
          )}
        />
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

      {canLive && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Label htmlFor="live-travel">{t("Live travel")}</Label>
          <Switch id="live-travel" checked={live} onCheckedChange={setLive} disabled={busy} />
        </div>
      )}
      <KeyboardView
        layout={layout}
        selected={selected?.matrixIndex ?? null}
        entries={new Map()}
        modified={new Set(settings.keys.filter((k) => k.kind !== KIND_PLAIN).map((k) => k.slot))}
        depth={depthMap}
        labelFor={(k) => {
          if (live && depth && k.matrixIndex !== null && depth[k.matrixIndex] > 0) {
            return (depth[k.matrixIndex] * unit).toFixed(decimals);
          }
          const s = k.matrixIndex === null ? undefined : bySlot.get(k.matrixIndex);
          if (!s) return k.text ?? k.code;
          const kind = KINDS.find((x) => x.value === s.kind);
          return s.kind === KIND_PLAIN
            ? `${s.travel.toFixed(decimals)}${s.rapidTrigger ? " RT" : ""}`
            : (kind?.label() ?? String(s.kind));
        }}
        onSelect={setSelected}
      />
      <p className="text-center text-xs text-muted-foreground">
        {live
          ? t("Press keys: each cap shows how far it is pressed, in millimetres.")
          : t(
              "Each key shows its actuation point, or its kind when it is not a plain key. Click a key to edit it alone.",
            )}
      </p>
      {live && (
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
          <span>
            {bottomed.length < 8
              ? t("Press every key to the bottom to compare them: {n} so far.", { n: bottomed.length })
              : shortKeys.length === 0
                ? t("{n} keys bottom out at about {mm} mm. None reads short.", {
                    n: bottomed.length,
                    mm: (bottomMedian * unit).toFixed(decimals),
                  })
                : t("{n} keys bottom out at about {mm} mm. These read short: {keys}.", {
                    n: bottomed.length,
                    mm: (bottomMedian * unit).toFixed(decimals),
                    keys: shortKeys.join(", "),
                  })}
          </span>
          {bottomed.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setPeak(null)}>
              {t("Start again")}
            </Button>
          )}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {draftAll && (
          <Section title={t("All keys")} hint={t("Written to every key at once. Keys with a kind keep it.")}>
            <div className="space-y-4">
              {models.length > 0 && (
                <div className="flex items-center justify-between text-sm">
                  <Label>{t("Switch")}</Label>
                  <ModelSelect value={allModel} types={models} onChange={setAllModel} disabled={!writable} keep />
                </div>
              )}
              <PlainRows value={draftAll} ranges={ranges} unit={unit} onChange={setDraftAll} />
              <Button size="sm" onClick={applyAll} disabled={!writable || busy}>
                {busy ? t("Writing. Leave the keyboard plugged in.") : t("Apply to all keys")}
              </Button>
            </div>
          </Section>
        )}
        {draftKey && selected && (
          <Section title={<span className="font-mono">{selected.text ?? selected.code}</span>}>
            <div className="space-y-4">
              {models.length > 0 && (
                <div className="flex items-center justify-between text-sm">
                  <div>
                    <Label>{t("Switch")}</Label>
                    <p className="text-xs text-muted-foreground">{t("What is fitted in this socket.")}</p>
                  </div>
                  <ModelSelect
                    value={draftKey.switchType}
                    types={models}
                    onChange={(c) => setDraftKey({ ...draftKey, switchType: c ?? draftKey.switchType })}
                    disabled={!writable}
                  />
                </div>
              )}
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
              {live && selectedSlot !== null && (
                <div className="space-y-2 rounded-md border p-3 text-sm">
                  <div className="flex items-baseline justify-between">
                    <Label>{t("Live")}</Label>
                    <span className="font-mono text-muted-foreground">{nowMm.toFixed(decimals)} mm</span>
                  </div>
                  <Trace
                    values={trace.map((c) => c * unit)}
                    max={FULL_TRAVEL_MM}
                    marks={[draftKey.travel, draftKey.lift]}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!writable || peakMm <= 0}
                      onClick={() => setDraftKey({ ...draftKey, travel: peakSet })}
                    >
                      {peakSet < peakMm - unit / 2
                        ? t("Actuate as deep as this board allows: {mm} mm", { mm: peakSet.toFixed(decimals) })
                        : t("Actuate at the deepest point: {mm} mm", { mm: peakSet.toFixed(decimals) })}
                    </Button>
                    {draftKey.rapidTrigger && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!writable || maxLiftMm <= 0}
                        onClick={() => setDraftKey({ ...draftKey, rtLift: liftSet })}
                      >
                        {t("Release step from the largest lift: {mm} mm", { mm: liftSet.toFixed(decimals) })}
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "Press the key the way you type. The deepest point and the largest lift that did not let go are kept until you pick another key. Apply writes them.",
                    )}
                  </p>
                </div>
              )}
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
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
