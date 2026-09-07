// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// The board picture lit by the effect the Lighting page holds, animated on
// the firmware's 5 ms tick. Paints straight into the DOM from a frame
// loop rather than through React state, so a 100-key picture at 60 fps
// costs one style write per key and no renders.

import { useEffect, useMemo, useRef } from "react";
import type { BoardLayout } from "@/lib/layout-loader";
import { FRAME_MS, colorAt, type EffectParam, type Family, type Led } from "@/lib/effects";

export default function EffectPreview({
  layout,
  family,
  param,
}: {
  layout: BoardLayout;
  family: Family;
  param: EffectParam;
}) {
  const keys = useMemo(() => layout.keys.filter((k) => k.type !== "knob"), [layout]);
  const leds = useMemo<Led[]>(
    () =>
      keys.map((k) => ({
        x: (k.x + k.w / 2) / layout.canvas.width,
        y: (k.y + k.h / 2) / layout.canvas.height,
      })),
    [keys, layout],
  );
  const refs = useRef<(HTMLSpanElement | null)[]>([]);
  const paramRef = useRef(param);
  paramRef.current = param;

  useEffect(() => {
    const still =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const paint = (frame: number) => {
      const p = paramRef.current;
      for (let i = 0; i < leds.length; i++) {
        const el = refs.current[i];
        if (!el) continue;
        const [r, g, b] = colorAt(family, p, leds[i], i, frame);
        el.style.background = `rgb(${r} ${g} ${b})`;
        el.style.boxShadow = `0 0 1.2cqw 0.3cqw rgb(${r} ${g} ${b} / 0.7)`;
      }
    };
    if (still) {
      paint(0);
      return;
    }
    let handle = 0;
    const start = performance.now();
    const tick = (now: number) => {
      if (document.visibilityState === "visible") paint(Math.floor((now - start) / FRAME_MS));
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [family, leds]);

  // Lights only: a soft glow where each LED sits, on a dark ground. No
  // caps, so it reads as the effect and not as something to paint.
  return (
    <div className="w-full" style={{ containerType: "inline-size" }}>
      <div className="mx-auto max-w-[920px] rounded-2xl bg-black p-[2.5%]">
        <div
          className="relative"
          style={{ aspectRatio: `${layout.canvas.width} / ${layout.canvas.height}` }}
        >
          {keys.map((k, i) => (
            <span
              key={`${k.code}-${k.matrixIndex ?? i}`}
              ref={(el) => {
                refs.current[i] = el;
              }}
              className="absolute rounded-full"
              style={{
                left: `${((k.x + k.w * 0.2) / layout.canvas.width) * 100}%`,
                top: `${((k.y + k.h * 0.2) / layout.canvas.height) * 100}%`,
                width: `${((k.w * 0.6) / layout.canvas.width) * 100}%`,
                height: `${((k.h * 0.6) / layout.canvas.height) * 100}%`,
                background: "#000",
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
