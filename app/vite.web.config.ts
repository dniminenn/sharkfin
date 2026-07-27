// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Browser build. Same app, three swaps: the backend seam goes to the wasm
// core over WebHID, and the two Tauri plugins get browser shims.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: [
      {
        find: /^@\/lib\/backend$/,
        replacement: path.resolve(__dirname, "src/web/backend.ts"),
      },
      {
        find: "@tauri-apps/plugin-dialog",
        replacement: path.resolve(__dirname, "src/web/dialog-shim.ts"),
      },
      {
        find: "@tauri-apps/plugin-opener",
        replacement: path.resolve(__dirname, "src/web/opener-shim.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "src") },
    ],
  },

  build: {
    outDir: "dist-web",
    rollupOptions: {
      input: path.resolve(__dirname, "web.html"),
    },
  },
});
