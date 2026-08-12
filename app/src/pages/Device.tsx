// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  exportConfig,
  factoryReset,
  getScreenVersion,
  writeScreenImage,
  getSettings,
  importConfig,
  setAutoOs,
  setDebounce,
  setOptions,
  setSleep,
  type ConnectedDevice,
  type DeviceSpec,
  type DeviceSettings,
  type KbOptions,
  type SleepTimes,
} from "@/lib/backend";
import { deviceLabel } from "@/lib/brands";

const SLEEP_MIN = 60;
const SLEEP_MAX = 3600;
const DEEP_MIN = 600;

// Mirrors DeviceSpec::screen_draw in registry.rs: drawing is offered only
// where the board's own firmware is known to parse the frame. yc500 boards
// draw in modes 16 and 24, yc3123-lineage gen2 boards in mode 16. Every
// other gen2 board hands the picture to a separate display chip and is
// refused, in the backend as well as here.
function canDraw(spec: DeviceSpec): boolean {
  if (!spec.screen) return false;
  if (spec.family === "yc500")
    return spec.screen.mode === "16" || spec.screen.mode === "24";
  return (
    spec.family === "gen2" &&
    spec.internalName.startsWith("yc3123_") &&
    spec.screen.mode === "16"
  );
}

// The boards drawing is refused on because the picture goes through a
// separate chip, as opposed to a mode sharkfin cannot pack yet.
function drawsElsewhere(spec: DeviceSpec): boolean {
  return (
    spec.family !== "yc500" &&
    !(spec.family === "gen2" && spec.internalName.startsWith("yc3123_"))
  );
}

function mins(seconds: number) {
  if (seconds === 0) return "off";
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${(m / 60).toFixed(1)} h` : `${m} min`;
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div>
        <Label className="text-sm">{label}</Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

// Debounce and sleep are onboard settings, so every write lands in flash.
// A drag changes nothing on the board: the number follows your finger and
// the keyboard is written once, when you let go. Same reasoning as the
// Lighting page, and the same reason an X86 wedged under a slider.

export default function DevicePage({
  device,
}: {
  device: ConnectedDevice | null;
}) {
  const [s, setS] = useState<DeviceSettings | null>(null);

  const load = useCallback(() => {
    getSettings()
      .then(setS)
      .catch((e) => toast.error(`Failed to read settings: ${e}`));
  }, []);

  useEffect(() => {
    if (device) load();
    else setS(null);
  }, [device, load]);

  // The display is a second chip with its own firmware. Asking it for a
  // version is the one screen command that means the same thing on both
  // protocol families, so it is safe on any board: one without a display
  // echoes the previous reply and comes back null.
  const [screenVersion, setScreenVersion] = useState<number | null>(null);
  useEffect(() => {
    if (!device) {
      setScreenVersion(null);
      return;
    }
    let live = true;
    getScreenVersion()
      .then((v) => live && setScreenVersion(v))
      .catch(() => {
        // A board that will not answer simply has no display to report.
      });
    return () => {
      live = false;
    };
  }, [device]);

  // The display wants exactly its own pixels, so the picture is scaled here
  // and handed over as plain RGB. Everything about the display's byte order
  // lives in the backend, where the pacing is.
  const [drawing, setDrawing] = useState(false);
  const drawImage = async (file: File) => {
    const screen = device?.spec.screen;
    if (!screen) return;
    setDrawing(true);
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = screen.w;
      canvas.height = screen.h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("could not prepare the picture");
      // Cover rather than stretch: a squashed photo looks like a bug.
      const scale = Math.max(screen.w / bitmap.width, screen.h / bitmap.height);
      const w = bitmap.width * scale;
      const h = bitmap.height * scale;
      ctx.drawImage(bitmap, (screen.w - w) / 2, (screen.h - h) / 2, w, h);
      const { data } = ctx.getImageData(0, 0, screen.w, screen.h);
      const rgb = new Array<number>(screen.w * screen.h * 3);
      for (let i = 0, j = 0; i < data.length; i += 4) {
        rgb[j++] = data[i];
        rgb[j++] = data[i + 1];
        rgb[j++] = data[i + 2];
      }
      await writeScreenImage(rgb);
      toast.success("Picture sent to the display.");
    } catch (e) {
      toast.error(`Could not draw the picture: ${e}`);
    } finally {
      setDrawing(false);
    }
  };

  /// Preview only. Nothing reaches the keyboard until commitSleep.
  const pushSleep = (patch: Partial<SleepTimes>) =>
    setS((prev) => (prev ? { ...prev, sleep: { ...prev.sleep, ...patch } } : prev));

  const commitSleep = (patch: Partial<SleepTimes>) =>
    setS((prev) => {
      if (!prev) return prev;
      const sleep = { ...prev.sleep, ...patch };
      setSleep(sleep).catch((e) => toast.error(`Write failed: ${e}`));
      return { ...prev, sleep };
    });

  /// Preview only. Nothing reaches the keyboard until commitDebounce.
  const pushDebounce = (value: number) =>
    setS((prev) => (prev ? { ...prev, debounce: value } : prev));

  const commitDebounce = (value: number) => {
    setS((prev) => (prev ? { ...prev, debounce: value } : prev));
    setDebounce(value).catch((e) => toast.error(`Write failed: ${e}`));
  };

  const pushAutoOs = (enabled: boolean) => {
    setS((prev) => (prev ? { ...prev, autoOs: enabled } : prev));
    setAutoOs(enabled).catch((e) => toast.error(`Write failed: ${e}`));
  };

  const doReset = async () => {
    try {
      await factoryReset();
      toast.success("Factory reset sent. The board reboots its settings.");
      setS(null);
      setTimeout(load, 4500);
    } catch (e) {
      toast.error(`Reset failed: ${e}`);
    }
  };

  const [transferring, setTransferring] = useState(false);

  const doExport = async () => {
    const path = await save({
      defaultPath: `${deviceLabel(device!.spec).split(" ").join("-")}.sharkfin.json`,
      filters: [{ name: "sharkfin config", extensions: ["json"] }],
    });
    if (!path) return;
    setTransferring(true);
    try {
      toast.success(await exportConfig(path));
    } catch (e) {
      toast.error(`Export failed: ${e}`);
    } finally {
      setTransferring(false);
    }
  };

  const doImport = async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "sharkfin config", extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    setTransferring(true);
    try {
      toast.success(await importConfig(path));
      load();
    } catch (e) {
      toast.error(`Import failed: ${e}`);
    } finally {
      setTransferring(false);
    }
  };

  const pushOptions = (patch: Partial<KbOptions>) => {
    setS((prev) => {
      if (!prev?.options) return prev;
      const options = { ...prev.options, ...patch };
      setOptions(options).catch((e) => toast.error(`Write failed: ${e}`));
      return { ...prev, options };
    });
  };

  if (!device) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Connect your keyboard by USB cable.
      </div>
    );
  }
  if (!s) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Reading device settings…
      </div>
    );
  }

  const wireless = device.spec.features.sleep24 || device.spec.features.sleepBT;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Device</h1>
        <p className="text-sm text-muted-foreground">
          {deviceLabel(device.spec)} · firmware {s.revision} · device ID{" "}
          {device.deviceId} · {device.spec.profiles} profiles
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Switches</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <Label>Debounce</Label>
              <span className="text-muted-foreground">{s.debounce}</span>
            </div>
            <Slider
              min={1}
              max={10}
              step={1}
              value={[s.debounce]}
              onValueChange={([v]) => pushDebounce(v)}
              onValueCommit={([v]) => commitDebounce(v)}
            />
            <p className="text-xs text-muted-foreground">
              Lower reacts faster; raise it if a switch starts chattering.
            </p>
          </div>
        </CardContent>
      </Card>

      {(device.spec.screen || screenVersion !== null) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Display</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex justify-between text-sm">
              <Label>Size</Label>
              <span className="text-muted-foreground">
                {device.spec.screen
                  ? `${device.spec.screen.w} by ${device.spec.screen.h}`
                  : "not recorded"}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <Label>Colour</Label>
              <span className="text-muted-foreground">
                {device.spec.screen
                  ? device.spec.screen.mode === "24"
                    ? "24-bit"
                    : "16-bit"
                  : "not recorded"}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <Label>Firmware</Label>
              <span className="text-muted-foreground">
                {screenVersion === null ? "no answer" : screenVersion.toString(16)}
              </span>
            </div>
            {canDraw(device.spec) && (
              <div className="space-y-2 pt-2">
                <input
                  type="file"
                  accept="image/*"
                  className="block w-full text-sm file:mr-3 file:rounded-md file:border-0
                             file:bg-secondary file:px-3 file:py-1.5 file:text-sm"
                  disabled={drawing}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) drawImage(file);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {drawing
                    ? "Writing. Leave the keyboard plugged in."
                    : "The picture is scaled to fit and replaces what is on the display."}
                </p>
              </div>
            )}
            {device.spec.screen &&
              !canDraw(device.spec) &&
              !drawsElsewhere(device.spec) && (
              <p className="text-xs text-muted-foreground">
                sharkfin reads this display but cannot draw on it yet.
              </p>
            )}
            {device.spec.screen && drawsElsewhere(device.spec) && (
              <p className="text-xs text-muted-foreground">
                sharkfin reads this display but cannot draw on it. The picture
                goes through a separate chip on this board.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Behaviour</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {s.options ? (
            <>
              <Row label="Windows key lock" hint="Ignore the Win key while gaming">
                <Switch
                  checked={s.options.winLock}
                  onCheckedChange={(v) => pushOptions({ winLock: v })}
                />
              </Row>
              <Row label="Swap WASD and arrows">
                <Switch
                  checked={s.options.wasdSwap}
                  onCheckedChange={(v) => pushOptions({ wasdSwap: v })}
                />
              </Row>
              <Row label="Backlight off">
                <Switch
                  checked={s.options.ledOff}
                  onCheckedChange={(v) => pushOptions({ ledOff: v })}
                />
              </Row>
            </>
          ) : (
            <p className="py-2 text-sm text-muted-foreground">
              This board's protocol family reports its switches in a layout
              sharkfin hasn't decoded, so they're hidden rather than shown
              wrong.
            </p>
          )}
          <Row
            label="Auto-detect host OS"
            hint="Board picks its Windows or macOS layer by itself"
          >
            <Switch
              checked={s.autoOs}
              onCheckedChange={pushAutoOs}
            />
          </Row>
          {s.options && (
            <Row label="Layout mode" hint="Switched on the keyboard itself">
              <Badge variant="outline">
                {s.options.macMode ? "macOS" : "Windows"}
              </Badge>
            </Row>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Backup</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Keymaps for every profile and layer, lighting and settings, as one
            file. Per-key paint patterns live in the Paint tab, because the firmware
            can't report those back.
          </p>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" disabled={transferring} onClick={doExport}>
              Export
            </Button>
            <Button size="sm" variant="outline" disabled={transferring} onClick={doImport}>
              {transferring ? "Working…" : "Import"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-base">Factory reset</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Clears every onboard profile, keymap, macro and light setting.
          </p>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="destructive" size="sm">
                Reset
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Factory reset this keyboard?</DialogTitle>
                <DialogDescription>
                  Every profile, remapped key, macro and lighting setting stored
                  on the board is erased. This cannot be undone from here.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="destructive" onClick={doReset}>
                  Erase and reset
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>

      {wireless && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Wireless sleep</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {(
              [
                ["sleep24", "Sleep · 2.4 GHz", "sleep24" as const, SLEEP_MIN],
                ["sleepBT", "Sleep · Bluetooth", "sleepBt" as const, SLEEP_MIN],
                ["sleep24", "Deep sleep · 2.4 GHz", "deep24" as const, DEEP_MIN],
                ["sleepBT", "Deep sleep · Bluetooth", "deepBt" as const, DEEP_MIN],
              ] as const
            ).map(([feature, label, key, min]) =>
              device.spec.features[feature] ? (
                <div key={key} className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <Label>{label}</Label>
                    <span className="text-muted-foreground">
                      {mins(s.sleep[key])}
                    </span>
                  </div>
                  <Slider
                    min={min}
                    max={SLEEP_MAX}
                    step={60}
                    value={[Math.max(s.sleep[key], min)]}
                    onValueChange={([v]) => pushSleep({ [key]: v })}
                    onValueCommit={([v]) => commitSleep({ [key]: v })}
                  />
                </div>
              ) : null,
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
