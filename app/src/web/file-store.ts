// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Hand-off between the dialog shim (which reads a picked file) and the web
// backend (which the UI then calls with the fake path the shim returned).

let picked: string | null = null;

export function stashPicked(text: string) {
  picked = text;
}

export function takePicked(): string | null {
  const t = picked;
  picked = null;
  return t;
}
