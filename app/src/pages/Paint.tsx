// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eraser, PaintBucket, Pipette } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useBoardLayout, type LayoutKey } from "@/lib/layout-loader";
import { writePerKey, type ConnectedDevice } from "@/lib/backend";

const SLOTS = 128;
const PALETTE = [
  "#ff0000",
  "#ff6a00",
  "#ffcc00",
  "#54ff3a",
  "#00e5ff",
  "#2b6bff",
  "#a855f7",
  "#ff2d95",
  "#ffffff",
  "#000000",
];

const STORE = "sharkfin.perkey";

function loadPattern(): string[] {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p) && p.length === SLOTS) return p;
    }
  } catch {
    // fall through to a fresh pattern
  }
  return Array(SLOTS).fill("#000000");
}

function toBlob(pattern: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < SLOTS; i++) {
    const v = parseInt((pattern[i] ?? "#000000").slice(1), 16);
    out.push((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }
  return out;
}

export default function PaintPage({ device }: { device: ConnectedDevice | null }) {
  const connected = !!device;
  const { layout, resolving } = useBoardLayout(device);
  const paintKeys = useMemo(
    () => layout.keys.filter((k) => k.matrixIndex !== null && k.type !== "knob"),
    [layout],
  );
  const [pattern, setPattern] = useState<string[]>(loadPattern);
  const [brush, setBrush] = useState(PALETTE[0]);
  const [busy, setBusy] = useState(false);
  const painting = useRef(false);

  useEffect(() => {
    localStorage.setItem(STORE, JSON.stringify(pattern));
  }, [pattern]);

  // Uploads go to flash and are rate-limited by the backend, so this is an
  // explicit action -- painting stays local until you send it.
  const apply = useCallback(async () => {
    setBusy(true);
    try {
      await writePerKey(toBlob(pattern), true);
      toast.success("Pattern sent to the keyboard");
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setBusy(false);
    }
  }, [pattern]);

  const paint = (k: LayoutKey, color = brush) => {
    setPattern((prev) => {
      const slot = k.matrixIndex!;
      if (prev[slot] === color) return prev;
      const next = [...prev];
      next[slot] = color;
      return next;
    });
  };

  const fillAll = (color: string) => setPattern(Array(SLOTS).fill(color));

  const canvas = { w: layout.canvas.width, h: layout.canvas.height };

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Paint</h1>
          <p className="text-sm text-muted-foreground">
            Click or drag to colour keys, then send it. Patterns go into the
            keyboard's flash, which is slow and easily upset, so sending is
            deliberate and takes a few seconds.
          </p>
        </div>
      </div>

      <div className="w-full" style={{ containerType: "inline-size" }}>
        <div className="keycap-plate mx-auto max-w-[920px] rounded-2xl p-[1.6%]">
          <div
            className="relative"
            style={{ aspectRatio: `${canvas.w} / ${canvas.h}` }}
            onPointerUp={() => (painting.current = false)}
            onPointerLeave={() => (painting.current = false)}
          >
            {resolving && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                Finding your keyboard…
              </div>
            )}
            {!resolving && paintKeys.map((k) => {
              const color = pattern[k.matrixIndex!] ?? "#000000";
              return (
                <button
                  key={`${k.code}-${k.matrixIndex}`}
                  title={k.text ?? k.code}
                  onPointerDown={() => {
                    painting.current = true;
                    paint(k);
                  }}
                  onPointerEnter={() => painting.current && paint(k)}
                  className="absolute rounded-[8%] border border-black/40 transition-transform hover:z-10 hover:scale-110"
                  style={{
                    left: `${(k.x / canvas.w) * 100}%`,
                    top: `${(k.y / canvas.h) * 100}%`,
                    width: `${(k.w / canvas.w) * 100}%`,
                    height: `${(k.h / canvas.h) * 100}%`,
                    background: color,
                    boxShadow:
                      color === "#000000"
                        ? "inset 0 0 0 1px rgba(255,255,255,0.08)"
                        : `0 0 10px ${color}66`,
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            {PALETTE.map((c) => (
              <button
                key={c}
                onClick={() => setBrush(c)}
                aria-label={c}
                className={cn(
                  "h-7 w-7 rounded-full border-2 transition-transform hover:scale-110",
                  brush === c ? "border-foreground" : "border-transparent",
                )}
                style={{
                  background: c,
                  boxShadow:
                    c === "#000000" ? "inset 0 0 0 1px rgba(255,255,255,.2)" : undefined,
                }}
              />
            ))}
            <input
              type="color"
              value={brush}
              onChange={(e) => setBrush(e.target.value)}
              className="h-7 w-7 cursor-pointer rounded-full border bg-transparent"
              aria-label="Custom brush colour"
            />
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => fillAll(brush)}>
              <PaintBucket className="mr-1 h-4 w-4" />
              Fill
            </Button>
            <Button variant="outline" size="sm" onClick={() => fillAll("#000000")}>
              <Eraser className="mr-1 h-4 w-4" />
              Clear
            </Button>
            <Button size="sm" disabled={!connected || busy} onClick={apply}>
              <Pipette className="mr-1 h-4 w-4" />
              {busy ? "Sending…" : "Apply to keyboard"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {!connected && (
        <p className="text-center text-sm text-muted-foreground">
          Connect the keyboard by USB cable to send this pattern.
        </p>
      )}
    </div>
  );
}
