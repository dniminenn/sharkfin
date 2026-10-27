// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import CheckPage from "./Check";
import { freshState, type WizardState } from "@/lib/wizard";
import type { ConnectedDevice, LedParam } from "@/lib/backend";

const mocks = vi.hoisted(() => ({
  held: null as unknown,
  sw: false,
  getSettings: vi.fn(),
  getLedParam: vi.fn(),
  setLedParam: vi.fn(),
  setSideLight: vi.fn(),
  setLedFlagsSwapped: vi.fn(),
}));

// Exercise the page's actual button handlers without a DOM or a device.
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => [initial === null ? mocks.held : initial, vi.fn()],
    useEffect: vi.fn(),
    useRef: (current: unknown) => ({ current }),
    useCallback: (fn: unknown) => fn,
  };
});
vi.mock("@/lib/backend", () => mocks);
vi.mock("@/lib/layout-loader", () => ({ useBoardLayout: () => ({}) }));
vi.mock("@/lib/i18n", () => ({ t: (s: string) => s }));
vi.mock("@/lib/led-flags-store", () => ({ effectiveSwap: () => mocks.sw, writeChoice: vi.fn() }));

type Element = ReactElement<Record<string, unknown>>;
function find(node: ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, predicate);
      if (found) return found;
    }
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (predicate(node)) return node;
  return find(node.props.children as ReactNode, predicate);
}

const preset: LedParam = {
  mode: 5, speed: 3, brightness: 1, option: 0, dazzle: false, r: 255, g: 0, b: 0,
};
const device = {
  spec: { id: 1042, family: "yc500", name: "Akko 5075B Plus", features: {} },
  readOnly: false,
} as ConnectedDevice;

function colours(state: WizardState) {
  mocks.held = { id: 1042, s: state };
  const page = CheckPage({ device, onContribute: vi.fn(), onRescan: vi.fn() });
  const step = find(page, (el) => typeof el.props.setColour === "function");
  expect(step).toBeDefined();
  const props = {
    ...step!.props,
    run: (fn: () => Promise<void>) => fn(),
    setColour: vi.fn(),
  };
  mocks.held = null;
  const render = step!.type as (props: unknown) => ReactNode;
  return { tree: render(props), props };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sw = false;
  mocks.getSettings.mockResolvedValue({});
  mocks.setLedFlagsSwapped.mockResolvedValue(undefined);
  mocks.setLedParam.mockResolvedValue(undefined);
});

function edgeState(): WizardState {
  return {
    ...freshState(), step: "colours", edgeClaim: "yes",
    colour: {
      sw: false, originals: { plain: { ...preset, dazzle: true }, swapped: preset },
      written: true, readBack: true, answer: "solid", restored: true, restoredReadBack: true,
      sideOriginal: null, sideWritten: false, edge: null, sideRestored: null,
    },
  };
}

async function click(tree: ReactNode, label: string) {
  const button = find(tree, (el) => el.props.children === label);
  expect(button).toBeDefined();
  await (button!.props.onClick as () => Promise<void>)();
}

describe("setup lighting safety", () => {
  it.each([false, true])("refuses ambiguous edge presets before any LED write with swapped=%s", async (sw) => {
    mocks.sw = sw;
    mocks.getSettings.mockResolvedValue({ sideLight: preset });
    const { tree, props } = colours(edgeState());
    await expect(click(tree, "Light the edge red")).rejects.toThrow("cannot preserve");
    expect(mocks.getSettings).toHaveBeenCalledTimes(2);
    expect(mocks.setLedFlagsSwapped).toHaveBeenLastCalledWith(sw);
    expect(mocks.setSideLight).not.toHaveBeenCalled();
    expect(mocks.setLedParam).not.toHaveBeenCalled();
    expect(props.setColour).not.toHaveBeenCalled();
  });
  it.each([false, true])("refuses to overwrite a lossy preset with swapped=%s", async (sw) => {
    mocks.sw = sw;
    mocks.getLedParam.mockResolvedValue({ ...preset });
    const { tree, props } = colours({ ...freshState(), step: "colours" });
    const button = find(tree, (el) => el.props.children === "Turn the board red");
    expect(button).toBeDefined();
    await expect((button!.props.onClick as () => Promise<void>)()).rejects.toThrow(
      "Setup cannot preserve this lighting preset. No colour was written. Skip this step.",
    );
    expect(mocks.getLedParam).toHaveBeenCalledTimes(2);
    expect(mocks.setLedFlagsSwapped).toHaveBeenLastCalledWith(sw);
    expect(mocks.setLedParam).not.toHaveBeenCalled();
    expect(props.setColour).not.toHaveBeenCalled();
  });

  it.each(["main first", "main second", "edge first", "edge second"])("restores the prior interpretation after a failed backup read: %s", async (where) => {
    mocks.sw = false;
    const edge = where.startsWith("edge");
    const reader = edge ? mocks.getSettings : mocks.getLedParam;
    if (where.endsWith("second")) reader.mockResolvedValueOnce(edge ? { sideLight: preset } : preset);
    reader.mockRejectedValueOnce(new Error("backup read failed"));
    const { tree } = colours(edge ? edgeState() : { ...freshState(), step: "colours" });
    await expect(click(tree, edge ? "Light the edge red" : "Turn the board red")).rejects.toThrow("backup read failed");
    expect(mocks.setLedFlagsSwapped).toHaveBeenLastCalledWith(false);
    expect(mocks.setLedParam).not.toHaveBeenCalled();
    expect(mocks.setSideLight).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves a representable edge backup through red and verified restore with swapped=%s", async (sw) => {
    mocks.sw = sw;
    const plain = { ...preset, dazzle: true };
    mocks.getSettings.mockResolvedValueOnce({ sideLight: plain }).mockResolvedValueOnce({ sideLight: preset });
    const state = edgeState();
    const fresh = colours(state);
    await click(fresh.tree, "Light the edge red");
    expect(mocks.setSideLight).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: 1, dazzle: false }));
    state.colour = fresh.props.setColour.mock.calls[fresh.props.setColour.mock.calls.length - 1][0];
    expect(state.colour).toEqual(expect.objectContaining({ sideOriginals: { plain, swapped: preset }, sideSw: sw, sideWritten: true }));
    mocks.getSettings.mockResolvedValue({ sideLight: sw ? preset : plain });
    const restore = colours(state);
    await click(restore.tree, "Yes");
    expect(mocks.setSideLight).toHaveBeenLastCalledWith(sw ? preset : plain);
    expect(restore.props.setColour).toHaveBeenLastCalledWith(expect.objectContaining({ sideRestored: true }));
  });

  it("restores the prior interpretation after a main restore read error", async () => {
    const state = edgeState();
    state.colour = { ...state.colour!, restored: false, answer: "cycling" };
    mocks.getLedParam.mockRejectedValueOnce(new Error("read failed"));
    const { tree, props } = colours(state);
    await click(tree, "Put the colour back");
    expect(props.setColour).toHaveBeenLastCalledWith(expect.objectContaining({ restoredReadBack: false }));
    expect(mocks.setLedFlagsSwapped).toHaveBeenLastCalledWith(false);
  });

  it("restores the prior interpretation after a failed read-only restore recheck", async () => {
    const state = edgeState();
    state.colour = { ...state.colour!, restoredReadBack: false, answer: "cycling" };
    mocks.getLedParam.mockRejectedValueOnce(new Error("read failed"));
    const { tree } = colours(state);
    await expect(click(tree, "Check the lighting again")).rejects.toThrow("read failed");
    expect(mocks.setLedFlagsSwapped).toHaveBeenLastCalledWith(false);
    expect(mocks.setLedParam).not.toHaveBeenCalled();
  });

  it("restores the prior interpretation when main recovery write fails", async () => {
    const state = edgeState();
    state.colour = { ...state.colour!, restored: false, answer: "cycling" };
    mocks.setLedParam.mockRejectedValueOnce(new Error("write failed"));
    const { tree } = colours(state);
    await expect(click(tree, "Put the colour back")).rejects.toThrow("write failed");
    expect(mocks.setLedFlagsSwapped).toHaveBeenLastCalledWith(false);
  });

  it.each(["mismatch", "missing", "read error", "write error", "match"])("verifies edge restore on answer and retry: %s", async (result) => {
    const original = { ...preset, dazzle: true };
    const state = edgeState();
    // Legacy backups with dazzle=true are representable and remain recoverable.
    state.colour = { ...state.colour!, sideOriginal: original, sideWritten: true };
    mocks.getSettings.mockResolvedValue({ sideLight: result === "match" ? original : result === "missing" ? null : preset });
    if (result === "read error") mocks.getSettings.mockRejectedValue(new Error("read failed"));
    if (result === "write error") mocks.setSideLight.mockRejectedValueOnce(new Error("write failed"));
    const first = colours(state);
    const action = click(first.tree, "Yes");
    if (result === "match") await action;
    else await expect(action).rejects.toThrow();
    expect(mocks.setSideLight).toHaveBeenCalledExactlyOnceWith(original);
    expect(first.props.setColour).toHaveBeenLastCalledWith(expect.objectContaining({ sideRestored: result === "match" }));
    if (result !== "match") {
      state.colour = first.props.setColour.mock.calls[first.props.setColour.mock.calls.length - 1][0];
      mocks.getSettings.mockResolvedValue({ sideLight: original });
      const retry = colours(state);
      await click(retry.tree, "Put the edge light back");
      expect(retry.props.setColour).toHaveBeenLastCalledWith(expect.objectContaining({ sideRestored: true }));
    }
  });

  it("refuses a legacy ambiguous edge restore without writing", async () => {
    const state = edgeState();
    state.colour = { ...state.colour!, sideOriginal: preset, sideWritten: true };
    const { tree, props } = colours(state);
    await expect(click(tree, "Yes")).rejects.toThrow("cannot preserve");
    expect(mocks.setSideLight).not.toHaveBeenCalled();
    expect(props.setColour).toHaveBeenLastCalledWith(expect.objectContaining({ sideRestored: false }));
  });

  it("rejects older ambiguous main originals without writing a lossy restore", async () => {
    const state = edgeState();
    state.colour = { ...state.colour!, originals: { plain: preset, swapped: preset }, restored: false };
    const { tree, props } = colours(state);
    await expect(click(tree, "Put the colour back")).rejects.toThrow("cannot preserve");
    expect(mocks.setLedParam).not.toHaveBeenCalled();
    expect(props.setColour).toHaveBeenLastCalledWith(expect.objectContaining({ restored: false }));
  });

  it("restores a distinguishable original's mode instead of the Static test mode", async () => {
    const original = { ...preset, dazzle: true };
    mocks.getLedParam.mockResolvedValue(original);
    const { tree, props } = colours({
      ...freshState(),
      step: "colours",
      colour: {
        sw: false,
        originals: { plain: original, swapped: preset },
        written: true, readBack: true, answer: "solid",
        restored: false, restoredReadBack: null,
        sideOriginal: null, sideWritten: false, edge: null, sideRestored: null,
      },
    });
    const button = find(tree, (el) => el.props.children === "Put the colour back");
    expect(button).toBeDefined();
    await (button!.props.onClick as () => Promise<void>)();
    expect(mocks.setLedParam).toHaveBeenCalledExactlyOnceWith(original);
    expect(mocks.setLedParam.mock.calls[0][0].mode).toBe(5);
    expect(props.setColour).toHaveBeenLastCalledWith(expect.objectContaining({
      restored: true, restoredReadBack: true,
    }));
  });
});
