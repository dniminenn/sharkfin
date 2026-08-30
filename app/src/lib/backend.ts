// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Typed wrappers around the Tauri command layer.
import { invoke } from "@tauri-apps/api/core";

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

export const scan = () => invoke<ScanResult>("scan");
/** Version and commit of this build. */
export const buildId = () => invoke<string>("build_id");
export const getSettings = () => invoke<DeviceSettings>("get_settings");
export const setDebounce = (value: number) =>
  invoke<void>("set_debounce", { value });
export const setSleep = (sleep: SleepTimes) =>
  invoke<void>("set_sleep", { sleep });
export const setOptions = (options: KbOptions) =>
  invoke<void>("set_options", { options });
export const setSideLight = (param: SledParam) =>
  invoke<void>("set_side_light", { param });
export const setAutoOs = (enabled: boolean) =>
  invoke<void>("set_auto_os", { enabled });
export const factoryReset = () => invoke<void>("factory_reset");
export const writePerKey = (colors: number[], activate: boolean) =>
  invoke<void>("write_per_key", { colors, activate });
export const getLedParam = () => invoke<LedParam>("get_led_param");
export const setLedParam = (param: LedParam) =>
  invoke<void>("set_led_param", { param });
export const getProfile = () => invoke<number>("get_profile");
/** The display's firmware version, or null on a board without one. */
export const getScreenVersion = () => invoke<number | null>("get_screen_version");
/** Draw one still frame. `rgb` is w*h*3 bytes in row order. */
export const writeScreenImage = (rgb: number[]) =>
  invoke<void>("write_screen_image", { rgb });
export const setProfile = (profile: number) =>
  invoke<void>("set_profile", { profile });
export const readKeymap = (profile: number) =>
  invoke<number[]>("read_keymap", { profile });
export const readFnKeymap = (layer: number) =>
  invoke<number[]>("read_fn_keymap", { layer });
export const setKey = (
  profile: number,
  slot: number,
  value: [number, number, number, number],
  fnLayer: boolean,
) => invoke<void>("set_key", { profile, slot, value, fnLayer });
export type MacroEvent =
  | { kind: "key"; usage: number; pressed: boolean; delayMs: number }
  | { kind: "mouseButton"; button: number; pressed: boolean; delayMs: number }
  | { kind: "mouseMove"; dx: number; dy: number; delayMs: number };

export interface Macro {
  repeat: number;
  events: MacroEvent[];
}

export const readMacro = (slot: number) => invoke<Macro>("read_macro", { slot });
export const writeMacro = (slot: number, data: Macro) =>
  invoke<void>("write_macro", { slot, data });

/** `path` reaches a discovered board the registry does not know; without it
 * the open board is used. */
export const contributionBundle = (path?: string) =>
  invoke<string>("contribution_bundle", { path });
export const exportConfig = (path: string) =>
  invoke<string>("export_config", { path });
export const importConfig = (path: string) =>
  invoke<string>("import_config", { path });

export const rawCommand = (
  opcode: number,
  payload: number[],
  checksum: "bit7" | "bit8" | "none",
) => invoke<number[]>("raw_command", { opcode, payload, checksum });
