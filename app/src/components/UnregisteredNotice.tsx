// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// A board the registry does not know, described from its own answers. The
// family came from the board, not from a file, so the owner sees what was
// detected and allows writes with a click; the report flow is one click away
// so the board gets a real entry.
import { useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { allowUnregistered, type ConnectedDevice } from "@/lib/backend";

export default function UnregisteredNotice({
  device,
  onAllowed,
  onContribute,
}: {
  device: ConnectedDevice;
  onAllowed: () => void;
  onContribute: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const family = device.spec.family ?? "";
  const allow = async () => {
    setBusy(true);
    try {
      await allowUnregistered();
      onAllowed();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-3 border-b bg-accent/40 px-4 py-2 text-sm">
      {device.readOnly ? (
        <ShieldAlert className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <ShieldCheck className="h-4 w-4 shrink-0 text-(--key-accent)" />
      )}
      <span className="min-w-0 flex-1 text-muted-foreground">
        {device.readOnly
          ? t(
              "This keyboard is not in sharkfin's list. It answers like a {family} board, so sharkfin can read it. Allow changes to write to it, and please send a report so it can be added.",
              { family },
            )
          : t(
              "Changes allowed for this session. Please send a report so this board can be added.",
            )}
      </span>
      {device.readOnly && (
        <Button size="sm" onClick={allow} disabled={busy}>
          {t("Allow changes")}
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={onContribute}>
        {t("Send a report")}
      </Button>
    </div>
  );
}
