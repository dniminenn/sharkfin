// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Eraser,
  PaintBucket,
  Paintbrush,
  Pipette,
  Plus,
  Save,
  Send,
  Undo2,
} from "lucide-react";
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
const MAX_SWATCHES = 10;

const STORE = "sharkfin.perkey";
const SWATCH_STORE = "sharkfin.perkey.swatches";
const PATTERNS_STORE = "sharkfin.patterns";
const MAX_PATTERNS = 6;

// One working pattern per board, so switching keyboards switches canvases.
// "default" is the bucket used before a board is connected; it doubles as
// the pre-0.3.3 store, so an existing pattern carries over.
function patternStore(board: string): string {
  return board === "default" ? STORE : `${STORE}.${board}`;
}

function loadPattern(board: string): string[] | null {
  try {
    const raw = localStorage.getItem(patternStore(board));
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p) && p.length === SLOTS) return p;
    }
  } catch {
    // fall through
  }
  return null;
}

type PatternBook = Record<string, string[][]>;

function loadBook(): PatternBook {
  try {
    const raw = localStorage.getItem(PATTERNS_STORE);
    if (raw) {
      const b = JSON.parse(raw);
      if (b && typeof b === "object" && !Array.isArray(b)) return b;
    }
  } catch {
    // fall through to an empty book
  }
  return {};
}

function loadSwatches(): string[] {
  try {
    const raw = localStorage.getItem(SWATCH_STORE);
    if (raw) {
      const s = JSON.parse(raw);
      if (Array.isArray(s) && s.every((c) => typeof c === "string")) {
        return s.slice(0, MAX_SWATCHES);
      }
    }
  } catch {
    // fall through to no swatches
  }
  return [];
}

function toBlob(pattern: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < SLOTS; i++) {
    const v = parseInt((pattern[i] ?? "#000000").slice(1), 16);
    out.push((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }
  return out;
}

// Lucide paintbrush and pipette outlines, drawn twice (dark under light) so
// the cursor stays visible on any key colour.
const BRUSH_PATHS = [
  "m14.622 17.897-10.68-2.913",
  "M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z",
  "M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15",
];
const PIPETTE_PATHS = [
  "m12 9-8.414 8.414A2 2 0 0 0 3 18.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 3.828 21h1.344a2 2 0 0 0 1.414-.586L15 12",
  "m18 9 .4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4 3.4-3.4a1 1 0 1 1 3 3z",
  "m2 22 .414-.414",
];

function cursorSvg(paths: string[], extra: string, transform: string): string {
  const p = (stroke: string, width: number) =>
    `<g stroke='${stroke}' stroke-width='${width}' transform='${transform}'>` +
    paths.map((d) => `<path d='${d}'/>`).join("") +
    "</g>";
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'" +
    " fill='none' stroke-linecap='round' stroke-linejoin='round'>" +
    p("#000000", 3) +
    p("#ffffff", 1.5) +
    extra +
    "</svg>";
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 4 24, crosshair`;
}

export default function PaintPage({ device }: { device: ConnectedDevice | null }) {
  const connected = !!device;
  const { layout, resolving } = useBoardLayout(device);
  const paintKeys = useMemo(
    () => layout.keys.filter((k) => k.matrixIndex !== null && k.type !== "knob"),
    [layout],
  );
  const boardKey = device?.spec.internalName ?? "default";
  const [pattern, setPattern] = useState<string[]>(
    () => loadPattern(boardKey) ?? loadPattern("default") ?? Array(SLOTS).fill("#000000"),
  );
  const [book, setBook] = useState<PatternBook>(loadBook);
  const [swatches, setSwatches] = useState<string[]>(loadSwatches);
  const [brush, setBrush] = useState(PALETTE[0]);
  const [tool, setTool] = useState<"brush" | "picker">("brush");
  const [hover, setHover] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const painting = useRef(false);
  const history = useRef<string[][]>([]);
  const board = useRef(boardKey);

  // On a board change, load that board's canvas if it has one; a canvas
  // painted before the board connected carries over instead.
  useEffect(() => {
    if (board.current === boardKey) return;
    board.current = boardKey;
    const stored = loadPattern(boardKey);
    if (stored) {
      history.current = [];
      setPattern(stored);
    }
  }, [boardKey]);

  useEffect(() => {
    if (board.current !== boardKey) return;
    localStorage.setItem(patternStore(boardKey), JSON.stringify(pattern));
  }, [pattern, boardKey]);

  useEffect(() => {
    localStorage.setItem(PATTERNS_STORE, JSON.stringify(book));
  }, [book]);

  useEffect(() => {
    localStorage.setItem(SWATCH_STORE, JSON.stringify(swatches));
  }, [swatches]);

  // The brush cursor carries a dot of the current colour at its tip.
  const cursor = useMemo(() => {
    if (tool === "picker") return cursorSvg(PIPETTE_PATHS, "", "translate(3 2)");
    const dot =
      `<circle cx='4' cy='24' r='3.2' fill='${brush}'` +
      " stroke='#ffffff' stroke-width='1.2'/>";
    return cursorSvg(BRUSH_PATHS, dot, "translate(4 6)");
  }, [tool, brush]);

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

  const pick = (k: LayoutKey) => {
    setBrush(pattern[k.matrixIndex!] ?? "#000000");
    setTool("brush");
  };

  // One history entry per stroke or fill, not per key.
  const snapshot = () => {
    history.current.push(pattern);
    if (history.current.length > 50) history.current.shift();
  };

  const undo = useCallback(() => {
    setPattern((prev) => {
      let top = history.current.pop();
      while (top && JSON.stringify(top) === JSON.stringify(prev)) {
        top = history.current.pop();
      }
      return top ?? prev;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  const saveSwatch = () => {
    if (PALETTE.includes(brush) || swatches.includes(brush)) return;
    setSwatches((prev) => [...prev.slice(-(MAX_SWATCHES - 1)), brush]);
  };

  const saved = useMemo(() => book[boardKey] ?? [], [book, boardKey]);

  const savePattern = () => {
    setBook((prev) => {
      const slots = prev[boardKey] ?? [];
      if (slots.some((s) => s.every((c, i) => c === pattern[i]))) return prev;
      return { ...prev, [boardKey]: [...slots.slice(-(MAX_PATTERNS - 1)), pattern] };
    });
  };

  const loadSlot = (slot: string[]) => {
    snapshot();
    setPattern(slot);
  };

  const deleteSlot = (index: number) => {
    setBook((prev) => ({
      ...prev,
      [boardKey]: (prev[boardKey] ?? []).filter((_, i) => i !== index),
    }));
  };

  const fillAll = (color: string) => {
    snapshot();
    setPattern(Array(SLOTS).fill(color));
  };

  const canvas = { w: layout.canvas.width, h: layout.canvas.height };

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Paint</h1>
          <p className="text-sm text-muted-foreground">
            Click or drag to colour keys, right-click to pick a colour up, then
            send it. Sending writes the keyboard's flash and takes a few
            seconds.
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            <Button
              variant={tool === "brush" ? "secondary" : "ghost"}
              size="icon-xs"
              aria-label="Brush"
              title="Brush"
              onClick={() => setTool("brush")}
            >
              <Paintbrush className="h-4 w-4" />
            </Button>
            <Button
              variant={tool === "picker" ? "secondary" : "ghost"}
              size="icon-xs"
              aria-label="Colour picker"
              title="Colour picker. Right-clicking a key does this too."
              onClick={() => setTool("picker")}
            >
              <Pipette className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Undo"
              title="Undo (Ctrl+Z)"
              onClick={undo}
            >
              <Undo2 className="h-4 w-4" />
            </Button>
          </div>

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

          <div className="flex items-center gap-2">
            {swatches.map((c) => (
              <button
                key={c}
                onClick={() => setBrush(c)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSwatches((prev) => prev.filter((s) => s !== c));
                }}
                aria-label={c}
                title="Saved colour. Right-click to remove."
                className={cn(
                  "h-7 w-7 rounded-md border-2 transition-transform hover:scale-110",
                  brush === c ? "border-foreground" : "border-transparent",
                )}
                style={{ background: c }}
              />
            ))}
            {swatches.length < MAX_SWATCHES && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Save colour"
                title="Save the current colour"
                onClick={saveSwatch}
              >
                <Plus className="h-4 w-4" />
              </Button>
            )}
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
              <Send className="mr-1 h-4 w-4" />
              {busy ? "Sending…" : "Apply to keyboard"}
            </Button>
          </div>

          <div className="flex w-full flex-wrap items-center gap-2 border-t pt-3">
            <span className="text-xs text-muted-foreground">Patterns</span>
            {saved.map((slot, i) => (
              <button
                key={i}
                onClick={() => loadSlot(slot)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  deleteSlot(i);
                }}
                aria-label={`Saved pattern ${i + 1}`}
                title="Load this pattern. Right-click to remove."
                className="keycap-plate relative h-8 w-14 overflow-hidden rounded-md border transition-transform hover:scale-110"
              >
                {paintKeys.map((k) => (
                  <span
                    key={`${k.code}-${k.matrixIndex}`}
                    className="absolute"
                    style={{
                      left: `${(k.x / canvas.w) * 100}%`,
                      top: `${(k.y / canvas.h) * 100}%`,
                      width: `${(k.w / canvas.w) * 100}%`,
                      height: `${(k.h / canvas.h) * 100}%`,
                      background: slot[k.matrixIndex!] ?? "#000000",
                    }}
                  />
                ))}
              </button>
            ))}
            {saved.length < MAX_PATTERNS && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Save pattern"
                title="Save the canvas as a pattern"
                onClick={savePattern}
              >
                <Save className="h-4 w-4" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="w-full" style={{ containerType: "inline-size" }}>
        <div className="keycap-plate mx-auto max-w-[920px] rounded-2xl p-[1.6%]">
          <div
            className="relative"
            style={{ aspectRatio: `${canvas.w} / ${canvas.h}`, cursor, touchAction: "none" }}
            onPointerUp={() => (painting.current = false)}
            onPointerLeave={() => {
              painting.current = false;
              setHover(null);
            }}
          >
            {resolving && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                Finding your keyboard…
              </div>
            )}
            {!resolving && paintKeys.map((k) => {
              const stored = pattern[k.matrixIndex!] ?? "#000000";
              // Hovering previews the brush so the first click has no surprise.
              const previewing =
                tool === "brush" && !painting.current && hover === k.matrixIndex;
              const color = previewing ? brush : stored;
              return (
                <button
                  key={`${k.code}-${k.matrixIndex}`}
                  title={k.text ?? k.code}
                  onPointerDown={(e) => {
                    // Touch implicitly captures the pointer on the first key,
                    // which would keep pointerenter from ever firing on the
                    // rest of a stroke.
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                      e.currentTarget.releasePointerCapture(e.pointerId);
                    }
                    if (tool === "picker") {
                      pick(k);
                      return;
                    }
                    snapshot();
                    painting.current = true;
                    paint(k);
                  }}
                  onPointerEnter={() => {
                    setHover(k.matrixIndex);
                    if (painting.current) paint(k);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    pick(k);
                  }}
                  className="absolute rounded-[8%] border border-black/40 transition-transform hover:z-10 hover:scale-110"
                  style={{
                    left: `${(k.x / canvas.w) * 100}%`,
                    top: `${(k.y / canvas.h) * 100}%`,
                    width: `${(k.w / canvas.w) * 100}%`,
                    height: `${(k.h / canvas.h) * 100}%`,
                    background: color,
                    cursor: "inherit",
                    opacity: previewing && brush !== stored ? 0.75 : 1,
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


      {!connected && (
        <p className="text-center text-sm text-muted-foreground">
          Connect the keyboard by USB cable to send this pattern.
        </p>
      )}
    </div>
  );
}
