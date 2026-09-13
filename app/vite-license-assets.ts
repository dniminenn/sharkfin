// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Puts the license and the third-party notices in the build output. The
// browser build conveys the bundled fonts and libraries with no installer
// to carry their terms, so the texts have to ship with the assets.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const FILES = ["LICENSE", "THIRD-PARTY-NOTICES.md"];

export function licenseAssets(): Plugin {
  return {
    name: "sharkfin-license-assets",
    apply: "build",
    generateBundle() {
      const root = path.resolve(__dirname, "..");
      for (const name of FILES) {
        this.emitFile({
          type: "asset",
          fileName: name,
          source: readFileSync(path.join(root, name)),
        });
      }
    },
  };
}
