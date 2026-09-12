// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// A keycap with a tick on it, drawn to sit beside the lucide icons in the
// nav: the same 24 grid, the same 2 px round strokes, the current colour.
export default function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="14" rx="3" />
      <path d="M7 21h10" />
      <path d="m8.5 10 2.5 2.5L15.5 8" />
    </svg>
  );
}
