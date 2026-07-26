// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Circle, Send, Square, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import KeyboardView from "@/components/KeyboardView";
import { useBoardLayout } from "@/lib/layout-loader";
import { CODE_TO_USAGE, entryLabel, usageLabel } from "@/lib/hid-usages";
import {
  readKeymap,
  readMacro,
  setKey,
  writeMacro,
  type ConnectedDevice,
  type MacroEvent,
} from "@/lib/backend";

const SLOTS = Array.from({ length: 50 }, (_, i) => i);
const PROFILES = [0, 1, 2];
const MODES = [
  { value: 0, label: "Repeat count" },
  { value: 1, label: "Toggle" },
  { value: 2, label: "While held" },
];
const MOUSE_LABELS = ["Mouse L", "Mouse R", "Mouse M", "Mouse Back", "Mouse Fwd"];
// JS button order is L, M, R; the protocol's is L, R, M.
const JS_TO_PROTO_BUTTON = [0, 2, 1, 3, 4];

function eventLabel(e: MacroEvent): string {
  if (e.kind === "key") return `${usageLabel(e.usage)} ${e.pressed ? "↓" : "↑"}`;
  if (e.kind === "mouseButton")
    return `${MOUSE_LABELS[e.button] ?? "Mouse ?"} ${e.pressed ? "↓" : "↑"}`;
  return `Move ${e.dx},${e.dy}`;
}

export default function MacrosPage({ device }: { device: ConnectedDevice | null }) {
  const connected = !!device;
  const layout = useBoardLayout(device);
  const [slot, setSlot] = useState(0);
  const [events, setEvents] = useState<MacroEvent[]>([]);
  const [repeat, setRepeat] = useState(1);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState(0);
  const [mode, setMode] = useState(0);
  const [entries, setEntries] = useState<Map<number, number[]> | null>(null);
  const lastTs = useRef<number | null>(null);
  const surface = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!connected) return;
    setEvents([]);
    setRepeat(1);
    readMacro(slot)
      .then((m) => {
        setEvents(m.events);
        setRepeat(Math.max(1, m.repeat));
      })
      .catch((e) => toast.error(`Failed to read macro: ${e}`));
  }, [connected, slot]);

  useEffect(() => {
    if (!connected) {
      setEntries(null);
      return;
    }
    readKeymap(profile)
      .then((matrix) => {
        const m = new Map<number, number[]>();
        for (let s = 0; s < 128; s++) m.set(s, matrix.slice(s * 4, s * 4 + 4));
        setEntries(m);
      })
      .catch(() => setEntries(null));
  }, [connected, profile]);

  const record = useCallback((e: MacroEvent) => {
    const now = performance.now();
    setEvents((prev) => {
      const next = [...prev];
      if (next.length > 0 && lastTs.current !== null) {
        const delta = Math.min(65535, Math.max(1, Math.round(now - lastTs.current)));
        const last = next[next.length - 1];
        if (last.kind !== "mouseMove") next[next.length - 1] = { ...last, delayMs: delta };
      }
      next.push(e);
      return next;
    });
    lastTs.current = now;
  }, []);

  const startRecording = () => {
    lastTs.current = null;
    setRecording(true);
    requestAnimationFrame(() => surface.current?.focus());
  };

  const onKey = (e: React.KeyboardEvent, pressed: boolean) => {
    if (!recording || e.repeat) return;
    e.preventDefault();
    const usage = CODE_TO_USAGE[e.code];
    if (usage === undefined) return;
    record({ kind: "key", usage, pressed, delayMs: 10 });
  };

  const onMouse = (e: React.MouseEvent, pressed: boolean) => {
    if (!recording) return;
    e.preventDefault();
    const button = JS_TO_PROTO_BUTTON[e.button];
    if (button === undefined) return;
    record({ kind: "mouseButton", button, pressed, delayMs: 10 });
  };

  const setDelay = (i: number, delayMs: number) =>
    setEvents((prev) => prev.map((e, j) => (j === i ? { ...e, delayMs } : e)));

  const send = async () => {
    setBusy(true);
    try {
      await writeMacro(slot, { repeat, events });
      toast.success(`Macro ${slot + 1} sent`);
    } catch (e) {
      toast.error(`Send failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const bound = useMemo(() => {
    const s = new Set<number>();
    if (!entries) return s;
    for (const [k, v] of entries) if (v[0] === 9 && v[2] === slot) s.add(k);
    return s;
  }, [entries, slot]);

  const bind = async (matrixIndex: number, keyName: string) => {
    setBusy(true);
    try {
      const value: [number, number, number, number] = [9, mode, slot, 0];
      await setKey(profile, matrixIndex, value, false);
      setEntries((prev) => {
        const next = new Map(prev);
        next.set(matrixIndex, value);
        return next;
      });
      toast.success(`${keyName} → Macro ${slot + 1}`);
    } catch (e) {
      toast.error(`Bind failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  if (!connected) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Connect your keyboard by USB cable to edit macros.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Macros</h1>
          <p className="text-sm text-muted-foreground">
            Record a sequence, send it to one of the 50 onboard slots, then
            bind it to a key. Slots load straight from the keyboard.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Slot</span>
          <Select value={String(slot)} onValueChange={(v) => setSlot(Number(v))}>
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SLOTS.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s + 1}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            Sequence
            <Badge variant="outline" className="ml-2">
              {events.length} events
            </Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Repeat</span>
            <Input
              type="number"
              min={1}
              max={65535}
              value={repeat}
              onChange={(e) => setRepeat(Math.min(65535, Math.max(1, Number(e.target.value) || 1)))}
              className="w-20"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={events.length === 0 || recording}
              onClick={() => setEvents([])}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" /> Clear
            </Button>
            {recording ? (
              <Button size="sm" variant="destructive" onClick={() => setRecording(false)}>
                <Square className="mr-1 h-3.5 w-3.5" /> Stop
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={startRecording}>
                <Circle className="mr-1 h-3.5 w-3.5 text-red-500" /> Record
              </Button>
            )}
            <Button size="sm" disabled={busy || recording || events.length === 0} onClick={send}>
              <Send className="mr-1 h-3.5 w-3.5" /> Send to keyboard
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {recording && (
            <div
              ref={surface}
              tabIndex={0}
              onKeyDown={(e) => onKey(e, true)}
              onKeyUp={(e) => onKey(e, false)}
              onMouseDown={(e) => onMouse(e, true)}
              onMouseUp={(e) => onMouse(e, false)}
              onContextMenu={(e) => e.preventDefault()}
              className="flex h-24 items-center justify-center rounded-lg border-2 border-dashed border-(--ring) text-sm text-muted-foreground outline-none"
            >
              Type or click here. Every press and release is captured.
            </div>
          )}
          {events.length === 0 && !recording ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Empty. Hit Record to capture a sequence.
            </div>
          ) : (
            <ScrollArea className={cn(events.length > 8 && "h-64")}>
              <div className="space-y-1 pr-3">
                {events.map((e, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 rounded-md border px-3 py-1.5 text-sm"
                  >
                    <span className="w-6 text-right font-mono text-xs text-muted-foreground">
                      {i + 1}
                    </span>
                    <span className="flex-1 font-medium">{eventLabel(e)}</span>
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      delay
                      <Input
                        type="number"
                        min={0}
                        max={e.kind === "mouseMove" ? 255 : 65535}
                        value={e.delayMs}
                        onChange={(ev) =>
                          setDelay(i, Math.max(0, Number(ev.target.value) || 0))
                        }
                        className="h-7 w-20"
                      />
                      ms
                    </label>
                    <button
                      onClick={() => setEvents((prev) => prev.filter((_, j) => j !== i))}
                      className="text-muted-foreground transition-colors hover:text-destructive"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            Bind macro {slot + 1} to a key
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Mode</span>
            <Select value={String(mode)} onValueChange={(v) => setMode(Number(v))}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((m) => (
                  <SelectItem key={m.value} value={String(m.value)}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">Profile</span>
            <Select value={String(profile)} onValueChange={(v) => setProfile(Number(v))}>
              <SelectTrigger className="w-20">
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
        </CardHeader>
        <CardContent>
          {!entries ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Reading keymap…
            </div>
          ) : (
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                Click a key to bind it. Keys already running this macro are
                dotted; unbind from the Keys page.
              </p>
              <KeyboardView
                layout={layout}
                selected={null}
                entries={entries}
                modified={bound}
                labelFor={(k, entry) => (entry ? entryLabel(entry) : (k.text ?? k.code))}
                onSelect={(k) => !busy && bind(k.matrixIndex!, k.text ?? k.code)}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
