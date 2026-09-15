// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from "vitest/config";
import path from "node:path";
import { layoutIndex } from "./vite-layout-index";

export default defineConfig({
  plugins: [layoutIndex()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
