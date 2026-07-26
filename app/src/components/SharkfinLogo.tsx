// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
export default function SharkfinLogo({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="sharkfin"
      role="img"
    >
      <path
        d="M9.5 46.5
           C 11.5 33, 18 15.5, 36.5 7.2
           C 37.6 6.7, 38.6 7.6, 38.2 8.7
           C 36 14.5, 35.6 21.5, 39.4 28.2
           C 40.1 29.4, 39.3 30.4, 38.1 30.2
           C 36.9 30, 35.9 30.6, 36.6 31.8
           C 40.5 38.1, 47.5 43, 55 46.5
           Z"
        fill="currentColor"
      />
      <path
        d="M3 52.5 C 8 48.5, 13 48.5, 18 52.5 S 28 56.5, 33 52.5 S 43 48.5, 48 52.5 S 58 56.5, 61 52.5"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="round"
        opacity="0.45"
      />
      <path
        d="M14 59.5 C 17.5 56.7, 21 56.7, 24.5 59.5 S 31.5 62.3, 35 59.5"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
        opacity="0.22"
      />
    </svg>
  );
}
