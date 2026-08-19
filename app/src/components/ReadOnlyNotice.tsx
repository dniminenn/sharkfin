// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export default function ReadOnlyNotice({ onContribute }: { onContribute: () => void }) {
  return (
    <div className="flex items-center gap-3 border-b bg-accent/40 px-4 py-2 text-sm">
      <ShieldAlert className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-muted-foreground">
        {t("Read-only: sharkfin doesn't know this board's command set yet.")}
      </span>
      <Button size="sm" variant="outline" onClick={onContribute}>
        {t("Send a report")}
      </Button>
    </div>
  );
}
