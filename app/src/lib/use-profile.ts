// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// The onboard profile, shared by the Keys and Macros pages.
//
// Both pages read and write a profile's keymap, so the number they hold has
// to be the one the keyboard is actually running. It is read from the board
// on connect and written back when the user picks another, because editing a
// profile you are not typing on looks exactly like a write that did nothing.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getProfile, setProfile, type ConnectedDevice } from "@/lib/backend";

/** The most any board in the registry claims. A reply above this is a bad
 *  read rather than a profile, and following it would write to nothing. */
const MAX_PROFILES = 8;

export interface BoardProfile {
  /** Zero-based, as the wire uses it. */
  profile: number;
  /** How many the picker should offer. */
  count: number;
  /** Switch the board, then the page. */
  select: (profile: number) => void;
  /** A switch is in flight; writes should wait for it. */
  switching: boolean;
}

export function useBoardProfile(device: ConnectedDevice | null): BoardProfile {
  const claimed = Math.min(MAX_PROFILES, Math.max(1, device?.spec.profiles ?? 1));
  const [profile, setLocal] = useState(0);
  const [seen, setSeen] = useState(0);
  const [switching, setSwitching] = useState(false);

  // A board sitting on a profile proves that profile exists, whatever the
  // registry claims: the AK820 MAX reports 4 against a registry entry of 4.
  const count = Math.min(MAX_PROFILES, Math.max(claimed, seen + 1));

  const id = device?.spec.id;
  const path = device?.path;
  useEffect(() => {
    if (!device) {
      setLocal(0);
      setSeen(0);
      return;
    }
    let live = true;
    getProfile()
      .then((p) => {
        if (!live || p >= MAX_PROFILES) return;
        setSeen(p);
        setLocal(p);
      })
      .catch(() => {
        // Not fatal: the pages still edit profile 1, which is where an
        // unreadable board almost certainly is.
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, path]);

  const select = useCallback(
    (next: number) => {
      const previous = profile;
      setLocal(next);
      setSwitching(true);
      setProfile(next)
        .catch((e) => {
          setLocal(previous);
          toast.error(`Could not switch profile: ${e}`);
        })
        .finally(() => setSwitching(false));
    },
    [profile],
  );

  return { profile, count, select, switching };
}
