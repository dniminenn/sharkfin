// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { toast } from "sonner";
import { t } from "@/lib/i18n";

let said = false;

/** Said once per page load, the first time a key write went as a whole layer. */
export function noteWholeLayer(): void {
  if (said) return;
  said = true;
  toast(t("This keyboard rewrites its whole keymap for each change, so each one takes a few seconds."));
}
