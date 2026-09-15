// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later

/// <reference types="vite/client" />

declare module "virtual:layout-index" {
  import type { LayoutIndex } from "@/lib/layout-index";
  const index: LayoutIndex;
  export default index;
}
