// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Brush,
  HeartHandshake,
  Keyboard,
  Lightbulb,
  ListMusic,
  Radio,
  Settings2,
  Usb,
  Magnet,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { t, LOCALES, locale, setLocale } from "@/lib/i18n";
import { deviceLabel } from "@/lib/brands";
import { loadOwner } from "@/lib/owner-record";
import { loadWizard, setupDone } from "@/lib/wizard";
import {
  applyOwnerRecord,
  scan,
  type ConnectedDevice,
  type DiscoveredUnknown,
} from "@/lib/backend";
import ColorwayPicker from "@/components/ColorwayPicker";
import SharkfinLogo from "@/components/SharkfinLogo";
import PermissionNotice from "@/components/PermissionNotice";
import ReadOnlyNotice from "@/components/ReadOnlyNotice";
import UnregisteredNotice from "@/components/UnregisteredNotice";
import LightingPage from "@/pages/Lighting";
import KeymapPage from "@/pages/Keymap";
import DevicePage from "@/pages/Device";
import PaintPage from "@/pages/Paint";
import MacrosPage from "@/pages/Macros";
import ContributePage from "@/pages/Contribute";
import CheckPage from "@/pages/Check";
import CheckIcon from "@/components/CheckIcon";
import SwitchesPage, { hasSwitches } from "@/pages/Switches";

type Page =
  | "check"
  | "lighting"
  | "paint"
  | "keymap"
  | "switches"
  | "macros"
  | "settings"
  | "contribute";

const readOnly = (d: ConnectedDevice) => d.readOnly;

const NAV: {
  id: Page;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "check", label: "Setup", icon: CheckIcon },
  { id: "lighting", label: "Lighting", icon: Lightbulb },
  { id: "paint", label: "Paint", icon: Brush },
  { id: "keymap", label: "Keys", icon: Keyboard },
  { id: "switches", label: "Switches", icon: Magnet },
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
  const [asleep, setAsleep] = useState(false);
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

  // A board the owner has walked through the check keeps what the check
  // established. The record is applied once per connect; it sends nothing
  // to the board, so a doubled effect is harmless.
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!device) {
      applied.current = null;
      return;
    }
    const key = `${device.spec.id}:${device.path}`;
    if (applied.current === key) return;
    applied.current = key;
    const record = loadOwner(device.spec.id);
    if (!record) return;
    applyOwnerRecord(record)
      .then(() => doScan())
      .catch(() => {
        applied.current = null;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device?.spec.id, device?.path]);

  // The check earns a place in the nav on a board sharkfin does not know
  // or cannot write, until it has been run once. Everywhere else it is a
  // button on the Contribute tab.
  const needsCheck =
    !!device &&
    (device.spec.unregistered || device.readOnly) &&
    !setupDone(loadWizard(device.spec.id));

  const doScan = useCallback(async () => {
    try {
      const r = await scan();
      setDevice(r.connected);
      setUnknown(r.unknown[0] ?? null);
      setOpenFailed(r.openFailed);
      setStalled(r.stalled);
      setAsleep(r.keyboardOffline);
    } catch {
      setDevice(null);
      setUnknown(null);
      setOpenFailed(false);
      setAsleep(false);
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
      <aside className="flex w-56 shrink-0 flex-col bg-sidebar">
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
          {NAV.filter(
            ({ id }) =>
              (id !== "switches" || hasSwitches(device)) && (id !== "check" || needsCheck),
          ).map(
            ({ id, label, icon: Icon }) => (
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
            ),
          )}
        </nav>
        <div className="mt-auto space-y-2 p-3">
          <div className="rounded-xl bg-sidebar-accent/60 p-3">
            <div className="flex items-center gap-2">
              {device?.link === "receiver" ? (
                <Radio className="h-4 w-4 text-(--key-accent)" />
              ) : (
                <Usb
                  className={cn(
                    "h-4 w-4",
                    device ? "text-(--key-accent)" : "text-muted-foreground",
                  )}
                />
              )}
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {device
                    ? deviceLabel(device.spec)
                    : stalled
                      ? "Needs a replug"
                      : asleep
                        ? t("Keyboard asleep")
                        : unknown
                          ? unknown.product || "Unrecognized keyboard"
                          : scanning
                            ? "Scanning…"
                            : "No device"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {device ? (
                    <span
                      className={cn(
                        "mt-1 block truncate",
                        !readOnly(device) && "text-(--key-accent)",
                      )}
                    >
                      {device.spec.unregistered
                        ? t("not in the registry · {family}", {
                            family: device.spec.family ?? "",
                          })
                        : readOnly(device)
                          ? t("read-only")
                          : device.link === "receiver"
                            ? t("2.4 GHz · id {id}", { id: device.deviceId }) +
                              (device.battery === null
                                ? ""
                                : ` · ${device.battery}%`)
                            : t("USB · id {id}", { id: device.deviceId })}
                    </span>
                  ) : stalled ? (
                    t("Unplug, wait 10s, plug back in")
                  ) : asleep ? (
                    t("Press a key, or connect by cable")
                  ) : unknown ? (
                    <span className="mt-1 block">
                      {unknown.deviceId === null
                        ? t("no answer")
                        : t("not in the registry")}
                    </span>
                  ) : (
                    t("Connect by cable")
                  )}
                </div>
              </div>
            </div>
          </div>
          <ColorwayPicker />
          <Select value={locale} onValueChange={setLocale}>
            <SelectTrigger
              aria-label={t("Language")}
              className="h-8 w-full text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCALES.map(([value, label]) => (
                <SelectItem key={value} value={value} className="text-xs">
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        {device && device.spec.unregistered ? (
          <UnregisteredNotice
            device={device}
            onAllowed={doScan}
            onCheck={() => setPage("check")}
            onContribute={() => setPage("contribute")}
          />
        ) : (
          device &&
          readOnly(device) && (
            <ReadOnlyNotice onContribute={() => setPage("contribute")} />
          )
        )}
        <div className="flex-1 overflow-auto">
          {page === "check" && (
            <CheckPage
              device={device}
              onContribute={() => setPage("contribute")}
              onRescan={doScan}
            />
          )}
          {page === "lighting" && <LightingPage device={device} />}
          {page === "paint" && <PaintPage device={device} />}
          {page === "keymap" && (
            <KeymapPage device={device} onContribute={() => setPage("contribute")} />
          )}
          {page === "switches" && <SwitchesPage device={device} />}
          {page === "macros" && <MacrosPage device={device} />}
          {page === "settings" && <DevicePage device={device} />}
          {page === "contribute" && (
            <ContributePage
              device={device}
              unknown={unknown}
              onCheck={() => setPage("check")}
            />
          )}
        </div>
      </main>
      {!device && openFailed && <PermissionNotice />}
      <Toaster position="bottom-right" />
    </div>
  );
}
