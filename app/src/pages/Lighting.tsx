// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { BE_MODES } from "@/lib/lighting-modes";
import {
  getLedParam,
  getSettings,
  setLedParam,
  setOptions,
  setSideLight,
  type KbOptions,
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

export default function LightingPage({ connected }: { connected: boolean }) {
  const [param, setParam] = useState<LedParam | null>(null);
  const [side, setSide] = useState<SledParam | null>(null);
  const [opts, setOpts] = useState<KbOptions | null>(null);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!connected) {
      setParam(null);
      return;
    }
    getLedParam()
      .then(setParam)
      .catch((e) => toast.error(`Failed to read lighting: ${e}`));
    getSettings()
      .then((s) => {
        setSide(s.sideLight);
        setOpts(s.options);
      })
      .catch(() => {
        setSide(null);
        setOpts(null);
      });
  }, [connected]);

  const setLedOff = (ledOff: boolean) => {
    if (!opts || opts.ledOff === ledOff) return;
    const next = { ...opts, ledOff };
    setOpts(next);
    setOptions(next).catch((e) => toast.error(`Write failed: ${e}`));
  };

  const updateSide = (patch: Partial<SledParam>) => {
    setSide((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      clearTimeout(sideTimer.current);
      sideTimer.current = setTimeout(() => {
        setSideLight(next).catch((e) => toast.error(`Write failed: ${e}`));
      }, 120);
      return next;
    });
  };

  // Debounced push so slider drags don't flood the wire.
  const update = (patch: Partial<LedParam>) => {
    setParam((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      clearTimeout(pushTimer.current);
      pushTimer.current = setTimeout(() => {
        setLedParam(next).catch((e) => toast.error(`Write failed: ${e}`));
      }, 120);
      return next;
    });
  };

  // Black is not a colour the LEDs can show, so route it to the real
  // backlight-off switch instead, and wake the backlight on any colour pick.
  const pickColor = (rgb: { r: number; g: number; b: number }) => {
    if (isNearBlack(rgb) && opts) {
      setLedOff(true);
      toast("Backlight off. Pick a colour to light it back up.");
      return;
    }
    setLedOff(false);
    update({ ...rgb, dazzle: false });
  };

  if (!connected) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Connect your keyboard by USB cable to configure lighting.
      </div>
    );
  }
  if (!param) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Reading current lighting…
      </div>
    );
  }

  const mode = BE_MODES.find((m) => m.value === param.mode);
  const hex = rgbToHex(param.r, param.g, param.b);
  const colorless = mode?.noColor ?? false;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Lighting</h1>
        <p className="text-sm text-muted-foreground">
          Backlight effect, color and motion. Changes apply live.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Effect</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {BE_MODES.map((m) => (
              <button
                key={m.value}
                onClick={() => update({ mode: m.value, option: 0 })}
                className={cn(
                  "rounded-md border px-2 py-2 text-xs transition-colors sm:text-sm",
                  param.mode === m.value
                    ? "border-primary bg-primary/10 font-medium"
                    : "hover:bg-accent",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          {mode?.options && (
            <div className="flex items-center gap-2">
              <Label className="text-sm text-muted-foreground">Direction</Label>
              <div className="flex gap-1">
                {mode.options.map((opt, i) => (
                  <button
                    key={opt}
                    onClick={() => update({ option: i })}
                    className={cn(
                      "rounded-md border px-3 py-1 text-xs transition-colors",
                      param.option === i
                        ? "border-primary bg-primary/10 font-medium"
                        : "hover:bg-accent",
                    )}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className={cn(colorless && "opacity-50")}>
        <CardHeader>
          <CardTitle className="text-base">Color</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {opts?.ledOff && (
            <div className="rounded-md border border-(--ring) bg-accent/40 px-3 py-2 text-sm">
              The backlight is off. Pick a colour or rainbow to light it back
              up.
            </div>
          )}
          <div className="flex items-center gap-3">
            {SWATCHES.map((c) => (
              <button
                key={c}
                disabled={colorless}
                onClick={() => pickColor(hexToRgb(c))}
                className={cn(
                  "h-8 w-8 rounded-full border-2 transition-transform enabled:hover:scale-110",
                  !param.dazzle && hex === c
                    ? "border-foreground"
                    : "border-transparent",
                )}
                style={{ backgroundColor: c }}
                aria-label={c}
              />
            ))}
            <input
              type="color"
              value={hex}
              disabled={colorless}
              onChange={(e) => pickColor(hexToRgb(e.target.value))}
              className="h-8 w-8 cursor-pointer rounded-full border bg-transparent"
              aria-label="Custom color"
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="dazzle" className="text-sm">
              Rainbow cycle
            </Label>
            <Switch
              id="dazzle"
              disabled={colorless}
              checked={colorless ? true : param.dazzle}
              onCheckedChange={(v) => {
                if (v) setLedOff(false);
                update({ dazzle: v });
              }}
            />
          </div>
        </CardContent>
      </Card>

      {side && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Edge light</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {SIDE_MODES.map((m) => (
                <button
                  key={m.value}
                  onClick={() => updateSide({ mode: m.value })}
                  className={cn(
                    "rounded-md border px-2 py-2 text-xs transition-colors sm:text-sm",
                    side.mode === m.value
                      ? "border-primary bg-primary/10 font-medium"
                      : "hover:bg-accent",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  onClick={() => updateSide({ ...hexToRgb(c), dazzle: false })}
                  className={cn(
                    "h-7 w-7 rounded-full border-2 transition-transform hover:scale-110",
                    !side.dazzle && rgbToHex(side.r, side.g, side.b) === c
                      ? "border-foreground"
                      : "border-transparent",
                  )}
                  style={{ backgroundColor: c }}
                  aria-label={c}
                />
              ))}
              <div className="ml-auto flex items-center gap-2">
                <Label htmlFor="side-dazzle" className="text-xs">
                  Rainbow
                </Label>
                <Switch
                  id="side-dazzle"
                  checked={side.dazzle}
                  onCheckedChange={(v) => updateSide({ dazzle: v })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <Label>Brightness</Label>
                  <span className="text-muted-foreground">
                    {side.brightness}/4
                  </span>
                </div>
                <Slider
                  min={0}
                  max={4}
                  step={1}
                  value={[side.brightness]}
                  onValueChange={([v]) => updateSide({ brightness: v })}
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <Label>Speed</Label>
                  <span className="text-muted-foreground">{side.speed}/4</span>
                </div>
                <Slider
                  min={0}
                  max={4}
                  step={1}
                  value={[side.speed]}
                  onValueChange={([v]) => updateSide({ speed: v })}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Motion</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <Label>Brightness</Label>
              <span className="text-muted-foreground">{param.brightness}/4</span>
            </div>
            <Slider
              min={0}
              max={4}
              step={1}
              value={[param.brightness]}
              onValueChange={([v]) => update({ brightness: v })}
            />
          </div>
          <div
            className={cn("space-y-2", mode?.noSpeed && "pointer-events-none opacity-50")}
          >
            <div className="flex justify-between text-sm">
              <Label>Speed</Label>
              <span className="text-muted-foreground">{param.speed}/4</span>
            </div>
            <Slider
              min={0}
              max={4}
              step={1}
              value={[param.speed]}
              onValueChange={([v]) => update({ speed: v })}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
