// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Serves `virtual:layout-index`, the digest of the vendor pictures the
// layout loader scores before deciding which pictures to fetch.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { buildIndex } from "./src/lib/layout-index";

const ID = "virtual:layout-index";
const RESOLVED = "\0" + ID;

export function layoutIndex(): Plugin {
  return {
    name: "sharkfin-layout-index",
    resolveId(id) {
      return id === ID ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return;
      const dir = path.resolve(__dirname, "src/lib/layouts/vendor");
      const layouts: Record<string, Parameters<typeof buildIndex>[0][string]> = {};
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        const file = path.join(dir, name);
        this.addWatchFile(file);
        layouts[name.slice(0, -".json".length)] = JSON.parse(readFileSync(file, "utf8"));
      }
      return `export default ${JSON.stringify(buildIndex(layouts))};`;
    },
  };
}
