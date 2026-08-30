// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// The browser build's stand-in for src/lib/backend.ts: same names, same
// types, same behaviour, but the commands run in the wasm core over WebHID
// instead of crossing the Tauri bridge. The vite web config aliases
// "@/lib/backend" here; nothing else in the UI changes.

import init, * as core from "../../src-web/pkg/sharkfin_web";
import { takePicked } from "./file-store";

export interface DeviceFeatures {
  knob: string[];
  debounce: boolean;
  sleep24: boolean;
  sleepBT: boolean;
  magneticSwitches: boolean;
  screen: boolean;
  sideLight: boolean;
}

export interface ScreenSpec {
  w: number;
  h: number;
  /** `16` is RGB565, `24` is three bytes a pixel. */
  mode: string;
  layers: number;
}

export interface DeviceSpec {
  id: number;
  name: string;
  displayName?: string;
  company?: string;
  vendor: string;
  vendorId: number;
  productId: number;
  internalName: string;
  keyLayout: string;
  lightLayout: string;
  profiles: number;
  magnetic?: boolean;
  family?: string;
  /** The display, absent on a board without one. */
  screen?: ScreenSpec | null;
  features: DeviceFeatures;
  /** An owner's read sweep from this board is on file. */
  confirmed?: { issue: number; version: string } | null;
}

export interface ConnectedDevice {
  path: string;
  deviceId: number;
  spec: DeviceSpec;
  readOnly: boolean;
}

export interface DiscoveredUnknown {
  path: string;
  productId: number;
  product: string;
  deviceId: number | null;
}

export interface ScanResult {
  connected: ConnectedDevice | null;
  unknown: DiscoveredUnknown[];
  /** A keyboard is there but its node can't be opened; on Linux that is
   * almost always a missing udev rule. */
  openFailed: boolean;
  /** Firmware stalled; nothing is retried until the board is replugged. */
  stalled: boolean;
}

export interface LedParam {
  mode: number;
  speed: number;
  brightness: number;
  option: number;
  dazzle: boolean;
  r: number;
  g: number;
  b: number;
}

export interface SleepTimes {
  sleepBt: number;
  sleep24: number;
  deepBt: number;
  deep24: number;
}

export interface KbOptions {
  winLock: boolean;
  wasdSwap: boolean;
  ledOff: boolean;
  sideLedOff: boolean;
  macMode: boolean;
}

export interface SledParam {
  mode: number;
  speed: number;
  brightness: number;
  option: number;
  dazzle: boolean;
  r: number;
  g: number;
  b: number;
}

export interface DeviceSettings {
  debounce: number;
  sleep: SleepTimes;
  /** null when the board's family has no decoded option bitfield. */
  options: KbOptions | null;
  revision: string;
  autoOs: boolean;
  sideLight: SledParam | null;
}

const USAGE_PAGE = 0xffff;
const USAGE = 0x0002;

// Which vendor IDs to look for comes from the registry, not from a constant
// here: most of these boards are ROYUAN's 0x3151, but a minority ship under
// the brand's own ID and would otherwise never appear in the picker.
let vendorIds: number[] | null = null;

async function knownVendors(): Promise<number[]> {
  await ensure();
  if (!vendorIds) vendorIds = Array.from(core.vendor_ids());
  return vendorIds;
}

const isVendorCollection = (d: HIDDevice, vendors: number[]) =>
  vendors.includes(d.vendorId) &&
  d.collections.some((c) => c.usagePage === USAGE_PAGE && c.usage === USAGE);

let ready: Promise<void> | null = null;

function ensure(): Promise<void> {
  if (ready) return ready;
  const started = init().then(() => {
    // Cable pulled: invalidate the wasm session so scan reconnects.
    navigator.hid.addEventListener("disconnect", () => core.drop_session());
  });
  ready = started;
  return started;
}

export function hidAvailable(): boolean {
  return "hid" in navigator && window.isSecureContext;
}

/** Devices this origin already holds permission for. */
export async function grantedDevices(): Promise<HIDDevice[]> {
  if (!hidAvailable()) return [];
  const vendors = await knownVendors();
  const all = await navigator.hid.getDevices();
  return all.filter((d) => isVendorCollection(d, vendors));
}

/** Shows the browser's device picker. Must run from a user gesture. */
export async function requestDevice(): Promise<boolean> {
  const vendors = await knownVendors();
  const picked = await navigator.hid.requestDevice({
    filters: vendors.map((vendorId) => ({ vendorId, usagePage: USAGE_PAGE, usage: USAGE })),
  });
  return picked.length > 0;
}

export const scan = async (): Promise<ScanResult> => {
  const empty = { connected: null, unknown: [], openFailed: false, stalled: false };
  if (!hidAvailable()) return empty;
  await ensure();
  const st = JSON.parse(core.status() as string) as {
    connected: ConnectedDevice | null;
    stalled: boolean;
  };
  if (st.connected) return { ...empty, connected: st.connected };

  const devices = await grantedDevices();
  if (st.stalled) {
    // Opening a stalled device does not recover it. Wait for it to leave the
    // bus, which is what a replug does; then scanning resumes.
    if (devices.length === 0) {
      core.clear_stall();
    } else {
      return { ...empty, stalled: true };
    }
  }

  const unknown: DiscoveredUnknown[] = [];
  let openFailed = false;
  for (const d of devices) {
    try {
      const info = JSON.parse((await core.connect(d)) as string) as ConnectedDevice;
      return { ...empty, connected: info };
    } catch (e) {
      let deviceId: number | null = null;
      try {
        const f = JSON.parse(String(e)) as { kind?: string; deviceId?: number };
        if (f.kind === "stalled") return { ...empty, stalled: true };
        if (f.kind === "openFailed") {
          // Unopenable is not unknown: the board never got to speak.
          openFailed = true;
          continue;
        }
        deviceId = f.deviceId ?? null;
      } catch {
        // not a structured failure; fall through to an unknown row
      }
      unknown.push({
        path: "webhid",
        productId: d.productId,
        product: d.productName,
        deviceId,
      });
    }
  }
  return { ...empty, unknown, openFailed };
};

const withCore = async <T>(f: () => Promise<T>): Promise<T> => {
  await ensure();
  return f();
};

/** Version and commit of this build. */
export const buildId = (): Promise<string> =>
  withCore(async () => core.build_id());
export const getSettings = (): Promise<DeviceSettings> =>
  withCore(async () => JSON.parse((await core.get_settings()) as string));
export const setDebounce = (value: number) => withCore(() => core.set_debounce(value));
export const setSleep = (sleep: SleepTimes) =>
  withCore(() => core.set_sleep(JSON.stringify(sleep)));
export const setOptions = (options: KbOptions) =>
  withCore(() => core.set_options(JSON.stringify(options)));
export const setSideLight = (param: SledParam) =>
  withCore(() => core.set_side_light(JSON.stringify(param)));
export const setAutoOs = (enabled: boolean) => withCore(() => core.set_auto_os(enabled));
export const factoryReset = () => withCore(() => core.factory_reset());
export const writePerKey = (colors: number[], activate: boolean) =>
  withCore(() => core.write_per_key(new Uint8Array(colors), activate));
export const getLedParam = (): Promise<LedParam> =>
  withCore(async () => JSON.parse((await core.get_led_param()) as string));
export const setLedParam = (param: LedParam) =>
  withCore(() => core.set_led_param(JSON.stringify(param)));
export const getProfile = (): Promise<number> => withCore(() => core.get_profile());
/** The display's firmware version, or null on a board without one. */
export const getScreenVersion = (): Promise<number | null> =>
  withCore(async () => (await core.get_screen_version()) ?? null);
/** Draw one still frame. `rgb` is w*h*3 bytes in row order. */
export const writeScreenImage = (rgb: number[]): Promise<void> =>
  withCore(() => core.write_screen_image(new Uint8Array(rgb)));
export const setProfile = (profile: number) => withCore(() => core.set_profile(profile));
export const readKeymap = (profile: number): Promise<number[]> =>
  withCore(async () => Array.from(await core.read_keymap(profile)));
export const readFnKeymap = (layer: number): Promise<number[]> =>
  withCore(async () => Array.from(await core.read_fn_keymap(layer)));
export const setKey = (
  profile: number,
  slot: number,
  value: [number, number, number, number],
  fnLayer: boolean,
) => withCore(() => core.set_key(profile, slot, new Uint8Array(value), fnLayer));

export type MacroEvent =
  | { kind: "key"; usage: number; pressed: boolean; delayMs: number }
  | { kind: "mouseButton"; button: number; pressed: boolean; delayMs: number }
  | { kind: "mouseMove"; dx: number; dy: number; delayMs: number };

export interface Macro {
  repeat: number;
  events: MacroEvent[];
}

export const readMacro = (slot: number): Promise<Macro> =>
  withCore(async () => JSON.parse((await core.read_macro(slot)) as string));
export const writeMacro = (slot: number, data: Macro) =>
  withCore(() => core.write_macro(slot, JSON.stringify(data)));

/** With `path`, bundles a granted board the registry does not know; WebHID
 * paths are opaque, so the first granted device stands in for it. */
export const contributionBundle = (path?: string): Promise<string> =>
  withCore(async () => {
    if (path === undefined) return (await core.contribution_bundle()) as string;
    const [d] = await grantedDevices();
    if (!d) throw "no keyboard connected";
    return (await core.unknown_bundle(d)) as string;
  });

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const exportConfig = (path: string): Promise<string> =>
  withCore(async () => {
    const json = (await core.export_config()) as string;
    const name = path.split(/[\\/]/).pop() || "sharkfin-config.json";
    download(name, json);
    const profiles = (JSON.parse(json) as { profiles: unknown[] }).profiles.length;
    return `saved ${profiles} profiles to ${name}`;
  });

export const importConfig = (_path: string): Promise<string> =>
  withCore(async () => {
    const raw = takePicked();
    if (raw === null) throw "no file was picked";
    return (await core.import_config(raw)) as string;
  });

export const rawCommand = (
  opcode: number,
  payload: number[],
  checksum: "bit7" | "bit8" | "none",
): Promise<number[]> =>
  withCore(async () =>
    Array.from(await core.raw_command(opcode, new Uint8Array(payload), checksum)),
  );
