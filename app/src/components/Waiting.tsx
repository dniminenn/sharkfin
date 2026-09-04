// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import SharkfinLogo from "@/components/SharkfinLogo";

// Something to look at while the board answers. By cable a page loads in
// well under a second; through the 2.4 GHz receiver every exchange waits on
// the radio and a keymap layer takes over one.
export default function Waiting({ label }: { label: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <span className="fin-swim text-(--key-accent)">
        <SharkfinLogo size={40} />
      </span>
      <span className="text-sm">{label}</span>
    </div>
  );
}
