// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { COLORWAYS, applyColorway, initColorway } from "@/lib/colorways";

export default function ColorwayPicker() {
  const [active, setActive] = useState(() => initColorway());

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center justify-center gap-2 py-2">
        {COLORWAYS.map((cw) => (
          <Tooltip key={cw.id}>
            <TooltipTrigger asChild>
              <button
                aria-label={cw.label}
                onClick={() => {
                  applyColorway(cw.id);
                  setActive(cw.id);
                }}
                className={cn(
                  "h-5 w-5 rounded-full border transition-transform hover:scale-125",
                  active === cw.id
                    ? "border-ring ring-2 ring-ring/40"
                    : "border-border",
                )}
                style={{
                  background: `linear-gradient(135deg, ${cw.swatch[0]} 50%, ${cw.swatch[1]} 50%)`,
                }}
              />
            </TooltipTrigger>
            <TooltipContent side="top">{cw.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}
