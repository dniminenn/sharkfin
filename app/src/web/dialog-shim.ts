// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Stands in for @tauri-apps/plugin-dialog in the browser build. `save`
// returns the suggested filename (the backend turns the export into a
// download); `open` shows a file picker, stashes the contents, and returns a
// token path the backend redeems.

import { stashPicked } from "./file-store";

interface SaveOptions {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

export async function save(opts?: SaveOptions): Promise<string | null> {
  return opts?.defaultPath ?? "sharkfin-config.json";
}

export async function open(_opts?: unknown): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      stashPicked(await f.text());
      resolve(f.name);
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}
