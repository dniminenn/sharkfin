// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// The one UI element the browser build adds: WebHID needs a click before a
// page may see the keyboard, so this floats a connect button until the
// origin holds a device permission. After the grant, App's normal scan loop
// takes over.

import { useEffect, useState } from "react";
import { Usb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { grantedDevices, requestDevice } from "./backend";

type GateState = "checking" | "unpaired" | "paired";

export default function ConnectGate() {
  const [state, setState] = useState<GateState>("checking");

  useEffect(() => {
    let live = true;
    const check = async () => {
      const devices = await grantedDevices();
      if (!live) return;
      setState(devices.length ? "paired" : "unpaired");
    };
    check();
    const t = setInterval(check, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (state !== "unpaired") return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-lg">
        <span className="text-sm text-muted-foreground">
          Plug in the keyboard or its receiver, then
        </span>
        <Button size="sm" onClick={() => requestDevice().catch(() => undefined)}>
          <Usb className="mr-1 h-3.5 w-3.5" /> Connect keyboard
        </Button>
      </div>
    </div>
  );
}
