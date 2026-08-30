// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Brush,
  HeartHandshake,
  Keyboard,
  Lightbulb,
  ListMusic,
  Settings2,
  Usb,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { t, LOCALES, locale, setLocale } from "@/lib/i18n";
import { deviceLabel } from "@/lib/brands";
import { scan, type ConnectedDevice, type DiscoveredUnknown } from "@/lib/backend";
import ColorwayPicker from "@/components/ColorwayPicker";
import SharkfinLogo from "@/components/SharkfinLogo";
import PermissionNotice from "@/components/PermissionNotice";
import ReadOnlyNotice from "@/components/ReadOnlyNotice";
import LightingPage from "@/pages/Lighting";
import KeymapPage from "@/pages/Keymap";
import DevicePage from "@/pages/Device";
import PaintPage from "@/pages/Paint";
import MacrosPage from "@/pages/Macros";
import ContributePage from "@/pages/Contribute";

type Page = "lighting" | "paint" | "keymap" | "macros" | "settings" | "contribute";

const readOnly = (d: ConnectedDevice) => d.readOnly;

const NAV: { id: Page; label: string; icon: typeof Lightbulb }[] = [
  { id: "lighting", label: "Lighting", icon: Lightbulb },
  { id: "paint", label: "Paint", icon: Brush },
  { id: "keymap", label: "Keys", icon: Keyboard },
  { id: "macros", label: "Macros", icon: ListMusic },
  { id: "settings", label: "Device", icon: Settings2 },
  { id: "contribute", label: "Contribute", icon: HeartHandshake },
];

export default function App() {
  const [page, setPage] = useState<Page>("lighting");
  const [device, setDevice] = useState<ConnectedDevice | null>(null);
  const [unknown, setUnknown] = useState<DiscoveredUnknown | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [scanning, setScanning] = useState(true);
  const guided = useRef<number | null>(null);
  const guidedUnknown = useRef<string | null>(null);

  // Read-only boards can't do anything on the other tabs; point their owner
  // at the report flow once per board, never repeatedly.
  useEffect(() => {
    if (device && readOnly(device) && guided.current !== device.deviceId) {
      guided.current = device.deviceId;
      setPage("contribute");
    }
  }, [device]);

  // Boards the registry doesn't know can only be reported; same guidance.
  useEffect(() => {
    if (!device && unknown && guidedUnknown.current !== unknown.path) {
      guidedUnknown.current = unknown.path;
      setPage("contribute");
    }
  }, [device, unknown]);

  const doScan = useCallback(async () => {
    try {
      const r = await scan();
      setDevice(r.connected);
      setUnknown(r.unknown[0] ?? null);
      setOpenFailed(r.openFailed);
      setStalled(r.stalled);
    } catch {
      setDevice(null);
      setUnknown(null);
      setOpenFailed(false);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    doScan();
    const t = setInterval(doScan, 3000);
    return () => clearInterval(t);
  }, [doScan]);

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar">
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="text-primary">
            <SharkfinLogo size={26} />
          </span>
          <span className="font-mono text-lg font-bold tracking-tighter">
            sharkfin
          </span>
        </div>
        <Separator />
        <nav className="flex flex-col gap-1 p-2">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setPage(id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                page === id
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {t(label)}
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-2 p-3">
          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2">
              <Usb
                className={cn(
                  "h-4 w-4",
                  device ? "text-(--key-accent)" : "text-muted-foreground",
                )}
              />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {device
                    ? deviceLabel(device.spec)
                    : stalled
                      ? "Needs a replug"
                      : unknown
                        ? unknown.product || "Unrecognized keyboard"
                        : scanning
                          ? "Scanning…"
                          : "No device"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {device ? (
                    <Badge
                      variant="outline"
                      className={cn(
                        "mt-1",
                        !readOnly(device) && "text-(--key-accent)",
                      )}
                    >
                      {readOnly(device)
                        ? t("read-only")
                        : t("USB · id {id}", { id: device.deviceId })}
                    </Badge>
                  ) : stalled ? (
                    t("Unplug, wait 10s, plug back in")
                  ) : unknown ? (
                    <Badge variant="outline" className="mt-1">
                      {unknown.deviceId === null ? t("receiver") : t("not in the registry")}
                    </Badge>
                  ) : (
                    t("Connect by cable")
                  )}
                </div>
              </div>
            </div>
          </div>
          <ColorwayPicker />
          <select
            aria-label={t("Language")}
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
            className="w-full rounded-md border bg-transparent px-2 py-1 text-xs text-muted-foreground"
          >
            {LOCALES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        {device && readOnly(device) && (
          <ReadOnlyNotice onContribute={() => setPage("contribute")} />
        )}
        <div className="flex-1 overflow-auto">
          {page === "lighting" && <LightingPage connected={!!device} />}
          {page === "paint" && <PaintPage device={device} />}
          {page === "keymap" && <KeymapPage device={device} />}
          {page === "macros" && <MacrosPage device={device} />}
          {page === "settings" && <DevicePage device={device} />}
          {page === "contribute" && <ContributePage device={device} unknown={unknown} />}
        </div>
      </main>
      {!device && openFailed && <PermissionNotice />}
      <Toaster position="bottom-right" />
    </div>
  );
}
