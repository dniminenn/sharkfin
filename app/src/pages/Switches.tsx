// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Magnetic-switch settings: actuation and release point, rapid trigger and
// its sensitivities, bottom dead zone. Read for every magnetic gen2 board,
// written only where the board's own firmware has been read (registry gate).
// Each write is a flash save on the board, so the page applies on a button,
// never on a slider move.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { t } from "@/lib/i18n";
import { useBoardLayout, type LayoutKey } from "@/lib/layout-loader";
import KeyboardView from "@/components/KeyboardView";
import Waiting from "@/components/Waiting";
import {
  getSwitches,
  setSwitchKey,
  setSwitchesAll,
  type ConnectedDevice,
  type KeySwitch,
  type SwitchSettings,
  type TravelRange,
} from "@/lib/backend";

/** Mirrors DeviceSpec::hall_writes in registry.rs: the ry5088 lineage is
 *  the one whose handler and save path were read out of its firmware. */
export const canWriteSwitches = (d: ConnectedDevice): boolean =>
  !d.readOnly &&
  !!d.spec.magnetic &&
  d.spec.family === "gen2" &&
  d.spec.internalName.startsWith("ry5088_");

export const hasSwitches = (d: ConnectedDevice | null): boolean =>
  !!d && !!d.spec.magnetic && d.spec.family === "gen2";

const range = (
  r: TravelRange | undefined | null,
  min: number,
  max: number,
  step: number,
) => ({
  min: r?.min ?? min,
  max: r?.max ?? max,
  step: r?.step ?? step,
});

const fmt = (mm: number) => mm.toFixed(2);

function Row({
  label,
  value,
  r,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  r: { min: number; max: number; step: number };
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm">
        <Label>{label}</Label>
        <span className="text-muted-foreground">{fmt(value)} mm</span>
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

function Editor({
  title,
  hint,
  value,
  ranges,
  writable,
  busy,
  onChange,
  onApply,
  applyLabel,
}: {
  title: string;
  hint: string;
  value: KeySwitch;
  ranges: ReturnType<typeof rangesFor>;
  writable: boolean;
  busy: boolean;
  onChange: (k: KeySwitch) => void;
  onApply: () => void;
  applyLabel: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{hint}</p>
        <Row
          label={t("Actuation point")}
          value={value.travel}
          r={ranges.travel}
          onChange={(v) => onChange({ ...value, travel: v })}
        />
        <Row
          label={t("Release point")}
          value={value.lift}
          r={ranges.travel}
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
          disabled={!value.rapidTrigger}
          onChange={(v) => onChange({ ...value, rtPress: v })}
        />
        <Row
          label={t("Rapid trigger release")}
          value={value.rtLift}
          r={ranges.fireLift}
          disabled={!value.rapidTrigger}
          onChange={(v) => onChange({ ...value, rtLift: v })}
        />
        <Row
          label={t("Bottom dead zone")}
          value={value.deadBottom}
          r={ranges.deadzone}
          onChange={(v) => onChange({ ...value, deadBottom: v })}
        />
        <Button size="sm" onClick={onApply} disabled={!writable || busy}>
          {busy ? t("Writing. Leave the keyboard plugged in.") : applyLabel}
        </Button>
      </CardContent>
    </Card>
  );
}

const rangesFor = (d: ConnectedDevice) => ({
  travel: range(d.spec.travel?.travel, 0.1, 3.3, 0.01),
  firePress: range(d.spec.travel?.firePress, 0.01, 2.0, 0.01),
  fireLift: range(d.spec.travel?.fireLift, 0.01, 2.0, 0.01),
  deadzone: range(d.spec.travel?.deadzone, 0, 1.0, 0.1),
});

export default function SwitchesPage({
  device,
}: {
  device: ConnectedDevice | null;
}) {
  const { layout, resolving } = useBoardLayout(device);
  const [settings, setSettings] = useState<SwitchSettings | null>(null);
  const [selected, setSelected] = useState<LayoutKey | null>(null);
  const [draftAll, setDraftAll] = useState<KeySwitch | null>(null);
  const [draftKey, setDraftKey] = useState<KeySwitch | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!hasSwitches(device)) {
      setSettings(null);
      return;
    }
    try {
      const s = await getSwitches();
      setSettings(s);
      // The "all keys" draft starts from the most common key, so one click
      // without changes writes back what the board already has.
      const plain = s.keys.filter((k) => k.kind === 0);
      setDraftAll(plain[0] ?? s.keys[0] ?? null);
    } catch (e) {
      toast.error(t("Could not read switch settings: {e}", { e: String(e) }));
    }
  }, [device]);

  useEffect(() => {
    load();
    setSelected(null);
    setDraftKey(null);
  }, [load]);

  useEffect(() => {
    if (!selected || !settings) return;
    const k = settings.keys.find((k) => k.slot === selected.matrixIndex);
    setDraftKey(k ? { ...k } : null);
  }, [selected, settings]);

  if (!device) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {t("Connect your keyboard.")}
      </div>
    );
  }
  if (!hasSwitches(device)) {
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
  const ranges = rangesFor(device);
  const bySlot = new Map(settings.keys.map((k) => [k.slot, k]));

  const applyAll = async () => {
    if (!draftAll) return;
    setBusy(true);
    try {
      await setSwitchesAll(draftAll);
      toast.success(t("Switch settings written to every key."));
      await load();
    } catch (e) {
      toast.error(t("Write failed: {e}", { e: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const applyKey = async () => {
    if (!draftKey) return;
    setBusy(true);
    try {
      await setSwitchKey(draftKey);
      toast.success(t("Switch settings written."));
      await load();
    } catch (e) {
      toast.error(t("Write failed: {e}", { e: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {t("Switches")}
        </h1>
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
      </div>

      <KeyboardView
        layout={layout}
        selected={selected?.matrixIndex ?? null}
        entries={new Map()}
        modified={
          new Set(
            settings.keys.filter((k) => k.rapidTrigger).map((k) => k.slot),
          )
        }
        labelFor={(k) => {
          const s =
            k.matrixIndex === null ? undefined : bySlot.get(k.matrixIndex);
          return s ? fmt(s.travel) : (k.text ?? k.code);
        }}
        onSelect={setSelected}
      />
      <p className="text-center text-xs text-muted-foreground">
        {t(
          "Each key shows its actuation point. Highlighted keys have rapid trigger on. Click a key to edit it alone.",
        )}
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        {draftAll && (
          <Editor
            title={t("All keys")}
            hint={t("Written to every key at once.")}
            value={draftAll}
            ranges={ranges}
            writable={writable}
            busy={busy}
            onChange={setDraftAll}
            onApply={applyAll}
            applyLabel={t("Apply to all keys")}
          />
        )}
        {draftKey && selected && (
          <Editor
            title={selected.text ?? selected.code}
            hint={
              draftKey.kind === 0
                ? t("This key alone.")
                : t(
                    "This key carries an advanced mode the vendor app set (dynamic keystroke, mod-tap, toggle or snap). Writing here keeps that mode and changes only the travel values.",
                  )
            }
            value={draftKey}
            ranges={ranges}
            writable={writable}
            busy={busy}
            onChange={setDraftKey}
            onApply={applyKey}
            applyLabel={t("Apply to this key")}
          />
        )}
      </div>
    </div>
  );
}
