// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Banner, Chip, PageHeader, Section } from "@/components/Page";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import Waiting from "@/components/Waiting";
import EffectPreview from "@/components/EffectPreview";
import { useBoardLayout } from "@/lib/layout-loader";
import { readChoice, writeChoice } from "@/lib/led-flags-store";
import type { Family } from "@/lib/effects";
import { BE_MODES, MODE_LABELS, type LightMode } from "@/lib/lighting-modes";
import {
  getLedParam,
  getSettings,
  setLedFlagsSwapped,
  setLedParam,
  setOptions,
  setSideLight,
  type KbOptions,
  type ConnectedDevice,
  type LedParam,
  type SledParam,
} from "@/lib/backend";

// Side/edge light: its own small mode table, and speed is not inverted.
const SIDE_MODES = [
  { value: 0, label: "Off" },
  { value: 1, label: "Static" },
  { value: 2, label: "Breathing" },
  { value: 3, label: "Spectrum", noColor: true },
  { value: 4, label: "Wave" },
  { value: 5, label: "Snake" },
];

const SWATCHES = [
  "#ff0000",
  "#ff8000",
  "#ffff00",
  "#00ff00",
  "#00ffff",
  "#0000ff",
  "#ff00ff",
  "#ffffff",
];

function hexToRgb(hex: string) {
  const v = parseInt(hex.replace("#", ""), 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

// Below this the firmware renders "all LEDs off" (the backend floors such
// writes); picking it means the user wants the backlight off.
const isNearBlack = (c: { r: number; g: number; b: number }) =>
  Math.max(c.r, c.g, c.b) < 8;

// Lighting is onboard state: every write lands in flash, the same as a key
// or a macro. Measured on an X86, 39 of them a second apart wedged the
// firmware even though nothing exceeded its rate limit, because the limit
// was never the problem. So a drag changes nothing on the board: the
// picture follows your finger, and the keyboard is written once, when you
// let go.
const WRITE_GAP = 300;

/** The effects to offer: the board's own table when the registry has one,
 *  else the common set. Speed is capped at the wire's 0..4 whatever the
 *  vendor's slider claims. */
function modesFor(device: ConnectedDevice | null): { modes: LightMode[]; brightnessMax: number } {
  const table = device?.spec.light;
  if (!table) return { modes: BE_MODES, brightnessMax: 4 };
  const modes: LightMode[] = table.effects
    .filter((e) => e.mode in MODE_LABELS)
    .map((e) => ({
      value: e.mode,
      label: MODE_LABELS[e.mode],
      options: e.options ?? undefined,
      noColor: !e.rgb,
      noSpeed: e.speedMax == null,
      speedMax: Math.min(e.speedMax ?? 4, 4),
    }));
  return { modes, brightnessMax: Math.max(1, table.brightnessMax) };
}

export default function LightingPage({ device }: { device: ConnectedDevice | null }) {
  const connected = !!device;
  const { modes, brightnessMax } = modesFor(device);
  const { layout, resolving } = useBoardLayout(device);
  const [param, setParam] = useState<LedParam | null>(null);
  const [side, setSide] = useState<SledParam | null>(null);
  const [opts, setOpts] = useState<KbOptions | null>(null);
  /** Which way round this board reads the rainbow flag, and whether that is
   *  the owner's answer rather than the registry's. */
  const [swapped, setSwapped] = useState(false);
  const [owned, setOwned] = useState(false);
  const defaultSwap = useRef(false);
  const paramRef = useRef<LedParam | null>(null);
  const sideRef = useRef<SledParam | null>(null);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastSent = useRef(0);
  const lastSideSent = useRef(0);

  useEffect(() => {
    if (!device) {
      setParam(null);
      return;
    }
    // The flag decides how a reply is read as well as how a packet is
    // written, so the owner's answer goes in before the first read.
    const id = device.spec.id;
    const dflt = device.spec.ledFlagsSwapped ?? false;
    const stale = readChoice(id);
    const choice = stale && stale.dflt === dflt ? stale : null;
    if (stale && !choice) writeChoice(id, null);
    defaultSwap.current = dflt;
    setSwapped(choice ? choice.swapped : dflt);
    setOwned(!!choice);
    (choice ? setLedFlagsSwapped(choice.swapped) : Promise.resolve())
      .then(getLedParam)
      .then((p) => {
        paramRef.current = p;
        setParam(p);
      })
      .catch((e) => toast.error(t("Failed to read lighting: {e}", { e })));
    getSettings()
      .then((s) => {
        sideRef.current = s.sideLight;
        setSide(s.sideLight);
        setOpts(s.options);
      })
      .catch(() => {
        setSide(null);
        setOpts(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, device?.spec.id]);

  const setLedOff = (ledOff: boolean) => {
    if (!opts || opts.ledOff === ledOff) return;
    const next = { ...opts, ledOff };
    setOpts(next);
    setOptions(next).catch((e) => toast.error(t("Write failed: {e}", { e })));
  };

  /// Preview only. Nothing reaches the keyboard until commitSide.
  const updateSide = (patch: Partial<SledParam>) => {
    const base = sideRef.current;
    if (!base) return;
    const next = { ...base, ...patch };
    sideRef.current = next;
    setSide(next);
  };

  const commitSide = (patch?: Partial<SledParam>) => {
    if (patch) updateSide(patch);
    const next = sideRef.current;
    if (!next) return;
    clearTimeout(sideTimer.current);
    sideTimer.current = setTimeout(
      () => {
        lastSideSent.current = Date.now();
        setSideLight(next).catch((e) => toast.error(t("Write failed: {e}", { e })));
      },
      Math.max(0, WRITE_GAP - (Date.now() - lastSideSent.current)),
    );
  };

  /// Preview only. Nothing reaches the keyboard until commit.
  const update = (patch: Partial<LedParam>) => {
    const base = paramRef.current;
    if (!base) return;
    const next = { ...base, ...patch };
    paramRef.current = next;
    setParam(next);
  };

  /// For controls that stream while in use, like the OS colour dialog:
  /// preview every step, write once the user stops moving.
  const commitIdle = (patch: Partial<LedParam>) => {
    update(patch);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => commit(), 800);
  };

  const commit = (patch?: Partial<LedParam>) => {
    if (patch) update(patch);
    const next = paramRef.current;
    if (!next) return;
    clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(
      () => {
        lastSent.current = Date.now();
        setLedParam(next).catch((e) => toast.error(t("Write failed: {e}", { e })));
      },
      Math.max(0, WRITE_GAP - (Date.now() - lastSent.current)),
    );
  };

  // Black is not a colour the LEDs can show, so route it to the real
  // backlight-off switch instead, and wake the backlight on any colour pick.
  const pickColor = (rgb: { r: number; g: number; b: number }) => {
    if (isNearBlack(rgb) && opts) {
      setLedOff(true);
      toast(t("Backlight off. Pick a colour to light it back up."));
      return;
    }
    setLedOff(false);
    commit({ ...rgb, dazzle: false });
  };

  // The board keeps the flag it was sent, so the same settings go back out
  // under the other reading and the keyboard follows at once.
  const applySwap = (next: boolean) => {
    if (!device) return;
    const own = next !== defaultSwap.current;
    setSwapped(next);
    setOwned(own);
    writeChoice(device.spec.id, own ? { swapped: next, dflt: defaultSwap.current } : null);
    setLedFlagsSwapped(next)
      .then(() => commit())
      .catch((e) => toast.error(t("Write failed: {e}", { e })));
  };

  if (!connected) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {t("Connect your keyboard to configure lighting.")}
      </div>
    );
  }
  if (!param) {
    return (
      <div className="flex h-full items-center justify-center">
        <Waiting label={t("Reading current lighting…")} />
      </div>
    );
  }

  const mode = modes.find((m) => m.value === param.mode);
  const hex = rgbToHex(param.r, param.g, param.b);
  const colorless = mode?.noColor ?? false;
  // The preview is timed from the firmware of the two families; a board
  // whose family is still unknown is drawn on the gen2 clock.
  const family: Family = device.spec.family === "yc500" ? "yc500" : "gen2";

  const slider = (
    label: string,
    value: number,
    max: number,
    onChange: (v: number) => void,
    onCommit: (v: number) => void,
    muted = false,
  ) => (
    <div className={cn("space-y-2", muted && "pointer-events-none opacity-50")}>
      <div className="flex justify-between text-sm">
        <Label>{label}</Label>
        <span className="text-muted-foreground">
          {value}/{max}
        </span>
      </div>
      <Slider
        min={0}
        max={max}
        step={1}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        onValueCommit={([v]) => onCommit(v)}
      />
    </div>
  );

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <PageHeader
        title={t("Lighting")}
        hint={t("Backlight effect, color and motion. Changes apply live.")}
      />

      {!resolving && !opts?.ledOff && (
        <EffectPreview
            layout={layout}
            family={family}
            param={{
              mode: param.mode,
              speed: param.speed,
              brightness: param.brightness,
              brightnessMax,
              option: param.option,
              rainbow: colorless || param.dazzle,
              r: param.r,
              g: param.g,
              b: param.b,
            }}
          />
      )}

      <Section title={t("Effect")}>
        <div className="flex flex-wrap gap-1">
          {modes.map((m) => (
            <Chip key={m.value} on={param.mode === m.value} onClick={() => commit({ mode: m.value, option: 0 })}>
              {t(m.label)}
            </Chip>
          ))}
        </div>
        {mode?.options && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{t("Direction")}</span>
            {mode.options.map((opt, i) =>
              opt === null ? null : (
                <Chip key={opt} on={param.option === i} onClick={() => commit({ option: i })} className="text-xs">
                  {t(opt)}
                </Chip>
              ),
            )}
          </div>
        )}
      </Section>

      <Section
        title={t("Color")}
        hint={colorless ? t("This effect brings its own colours.") : undefined}
        className={cn(colorless && "opacity-50")}
      >
        {opts?.ledOff && (
          <Banner>{t("The backlight is off. Pick a colour or rainbow to light it back up.")}</Banner>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {SWATCHES.map((c) => (
            <button
              key={c}
              disabled={colorless}
              onClick={() => pickColor(hexToRgb(c))}
              className={cn(
                "h-8 w-8 rounded-full transition-transform enabled:hover:scale-110",
                !param.dazzle && hex === c && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
              )}
              style={{ backgroundColor: c }}
              aria-label={c}
            />
          ))}
          <input
            type="color"
            value={hex}
            disabled={colorless}
            onChange={(e) => commitIdle({ ...hexToRgb(e.target.value), dazzle: false })}
            className="h-8 w-8 cursor-pointer rounded-full bg-transparent"
            aria-label={t("Custom color")}
          />
          <label htmlFor="dazzle" className="ml-auto flex items-center gap-2 text-sm">
            {t("Rainbow")}
            <Switch
              id="dazzle"
              disabled={colorless}
              checked={colorless ? true : param.dazzle}
              onCheckedChange={(v) => {
                if (v) setLedOff(false);
                commit({ dazzle: v });
              }}
            />
          </label>
        </div>
        {!colorless && (
          <p className="text-xs text-muted-foreground">
            {owned ? (
              <>
                {t("Swapped for this board.")}{" "}
                <button
                  className="text-primary underline underline-offset-2"
                  onClick={() => applySwap(defaultSwap.current)}
                >
                  {t("Undo")}
                </button>
              </>
            ) : (
              <>
                {t("Rainbow where you picked a colour, or one colour where you asked for the rainbow?")}{" "}
                <button
                  className="text-primary underline underline-offset-2"
                  onClick={() => applySwap(!swapped)}
                >
                  {t("Swap them")}
                </button>
              </>
            )}
          </p>
        )}
      </Section>

      <Section title={t("Motion")}>
        <div className="grid gap-6 sm:grid-cols-2">
          {slider(t("Brightness"), param.brightness, brightnessMax, (v) => update({ brightness: v }), (v) => commit({ brightness: v }))}
          {slider(t("Speed"), param.speed, mode?.speedMax ?? 4, (v) => update({ speed: v }), (v) => commit({ speed: v }), !!mode?.noSpeed)}
        </div>
      </Section>

      {side && (
        <Section title={t("Edge light")}>
          <div className="flex flex-wrap gap-1">
            {SIDE_MODES.map((m) => (
              <Chip key={m.value} on={side.mode === m.value} onClick={() => commitSide({ mode: m.value })}>
                {t(m.label)}
              </Chip>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {SWATCHES.map((c) => (
              <button
                key={c}
                onClick={() => commitSide({ ...hexToRgb(c), dazzle: false })}
                className={cn(
                  "h-7 w-7 rounded-full transition-transform hover:scale-110",
                  !side.dazzle && rgbToHex(side.r, side.g, side.b) === c && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
                )}
                style={{ backgroundColor: c }}
                aria-label={c}
              />
            ))}
            <label htmlFor="side-dazzle" className="ml-auto flex items-center gap-2 text-sm">
              {t("Rainbow")}
              <Switch
                id="side-dazzle"
                checked={side.dazzle}
                onCheckedChange={(v) => commitSide({ dazzle: v })}
              />
            </label>
          </div>
          <div className="grid gap-6 sm:grid-cols-2">
            {slider(t("Brightness"), side.brightness, 4, (v) => updateSide({ brightness: v }), (v) => commitSide({ brightness: v }))}
            {slider(t("Speed"), side.speed, 4, (v) => updateSide({ speed: v }), (v) => commitSide({ speed: v }))}
          </div>
        </Section>
      )}
    </div>
  );
}
