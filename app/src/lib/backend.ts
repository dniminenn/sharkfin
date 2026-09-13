// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Typed wrappers around the Tauri command layer.
import { invoke } from "@tauri-apps/api/core";

/** Which build is running. The web backend exports "browser"; data
 * bundles carry it so a report says where it came from. */
export const BUILD: "app" | "browser" = "app";

export interface DeviceFeatures {
  knob: string[];
  debounce: boolean;
  sleep24: boolean;
  sleepBT: boolean;
  magneticSwitches: boolean;
  screen: boolean;
  sideLight: boolean;
}

export interface TravelRange {
  min?: number | null;
  max?: number | null;
  step?: number | null;
  default?: number | null;
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
  /** Ranges the vendor's UI offers for a magnetic board's travel settings,
   * in millimetres; absent on most records, and on every mechanical board. */
  travel?: {
    travel?: TravelRange;
    firePress?: TravelRange;
    fireLift?: TravelRange;
    deadzone?: TravelRange;
  } | null;
  /** The vendor lets the owner declare a different switch model. */
  switchReplaceable?: boolean;
  /** An owner's read sweep from this board is on file. */
  /** Built from the board's own answers because the registry has no entry
   * for its id. The app says so and asks before the first write. */
  unregistered?: boolean;
  /** Firmware lineage that reads the lighting flags nibble the other way
   * round; the backends encode and decode accordingly. */
  ledFlagsSwapped?: boolean;
  /** The backlight effects this board's firmware has, from the vendor's
   * per-board table. Absent when the table has no entry. */
  light?: LightLayout | null;
}

export interface LightEffect {
  /** LEDPARAM mode byte. */
  mode: number;
  /** Highest speed offered; absent for effects with no motion. */
  speedMax?: number | null;
  /** Takes a colour; otherwise always rainbow. */
  rgb?: boolean;
  /** Direction or variant names by option index; null marks an index this
   * board does not have. */
  options?: (string | null)[] | null;
}

export interface LightLayout {
  rgb: boolean;
  brightnessMax: number;
  effects: LightEffect[];
}

export interface ConnectedDevice {
  path: string;
  deviceId: number;
  spec: DeviceSpec;
  readOnly: boolean;
  /** What the Switches page may do: read the columns, write them, or write
   * the one board-wide record of a yc500 board below firmware 2.00. */
  switches: SwitchAccess;
  /** Firmware revision from 0x80, e.g. 0x0200 for 2.00; null when unanswered. */
  revision: number | null;
  /** Cable, or the 2.4 GHz receiver's relay. Factory reset and display pictures need the cable. */
  link: "usb" | "receiver";
  /** Percent, receiver link only. */
  battery: number | null;
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
  /** A receiver is paired but its keyboard is asleep or off. A key press
   * wakes it; so does the cable. */
  keyboardOffline: boolean;
}

export type SwitchAccess = "none" | "read" | "write" | "global";

/** The owner's answers about their own board, from the check. Flags land on
 * the spec only for a board the registry does not know; `switchWrites` is
 * the owner's felt round trip and applies to any board whose columns read. */
export interface OwnerRecord {
  allowed: boolean;
  magnetic: boolean;
  sideLight: boolean | null;
  switchWrites: boolean;
  profiles: number | null;
}

/** One key's magnetic-switch settings, millimetres. */
export interface KeySwitch {
  slot: number;
  /** Bits 0..6 of the mode byte: 0 plain, 2 dynamic keystroke, 3 mod-tap,
   * 4 toggle, 5 repeating toggle, 7 snap. */
  kind: number;
  rapidTrigger: boolean;
  travel: number;
  lift: number;
  rtPress: number;
  rtLift: number;
  deadBottom: number;
  /** Dynamic keystroke: the first point; `travel` is the second. */
  dksStart: number;
  /** Dynamic keystroke: one byte per sub-layer, four 2-bit cells, one per travel event. */
  dksActions: number[];
  /** Mod-tap: milliseconds held before the hold action fires. */
  mtTimeMs: number;
  /** Snap: the partner's slot, 255 for none. */
  snapPartner: number;
}

export interface SwitchSettings {
  format: "gen2" | "yc500";
  unitMm: number;
  keys: KeySwitch[];
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
/** The owner allows writes to a board the registry does not know, this session. */
export const allowUnregistered = () => invoke<void>("allow_unregistered");
/** What the owner established about this board in the check. Sends nothing;
 * applied on every connect so the board keeps what the check unlocked. */
export const applyOwnerRecord = (record: OwnerRecord) =>
  invoke<void>("apply_owner_record", { record });
/** Open one slot's switch columns to the check's felt test, or close it. */
export const setSwitchTrial = (slot: number | null) =>
  invoke<void>("set_switch_trial", { slot });
export const getSwitches = () => invoke<SwitchSettings>("get_switches");
export const setSwitchKey = (key: KeySwitch) => invoke<void>("set_switch_key", { key });
/** One or two keys in one visit; a snap pair goes through here. */
export const setSwitchKeys = (keys: KeySwitch[]) => invoke<void>("set_switch_keys", { keys });
/** The plain settings on every key; `modes` keeps each key's kind as read. */
export const setSwitchesAll = (key: KeySwitch, modes: number[]) =>
  invoke<void>("set_switches_all", { key, modes });
/** yc500 only: 0 comfort, 1 sensitive, 2 gaming, 3 custom; null elsewhere. */
export const getSwitchPreset = () => invoke<number | null>("get_switch_preset");
export const setSwitchPreset = (preset: number) => invoke<void>("set_switch_preset", { preset });
/** yc500 below 2.00: the one record, for every key or the record's slot. */
export const setSwitchesGlobal = (key: KeySwitch, all: boolean) =>
  invoke<void>("set_switches_global", { key, all });
/** One of the four keymap sub-layers of a profile, 512 bytes. */
export const readKeymapLayer = (profile: number, sublayer: number) =>
  invoke<number[]>("read_keymap_layer", { profile, sublayer });
export const setKeyLayer = (profile: number, sublayer: number, slot: number, value: number[]) =>
  invoke<void>("set_key_layer", { profile, sublayer, slot, value, fnLayer: false });
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
/** Which way round this board reads the rainbow flag, from the owner. */
export const setLedFlagsSwapped = (swapped: boolean) =>
  invoke<void>("set_led_flags_swapped", { swapped });
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
