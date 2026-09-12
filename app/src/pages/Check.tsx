// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// The check-your-board wizard. Reads first, then three writes, each behind
// its own button: a colour, a profile switch and back, one key. Its state
// lives in localStorage by device id, so a replug lands back on the same
// step. Nothing here writes from an effect.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Minus, RotateCcw, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Banner, PageHeader, Section } from "@/components/Page";
import KeyboardView from "@/components/KeyboardView";
import Waiting from "@/components/Waiting";
import { t } from "@/lib/i18n";
import { deviceLabel } from "@/lib/brands";
import { useBoardLayout } from "@/lib/layout-loader";
import { effectiveSwap, writeChoice } from "@/lib/led-flags-store";
import { emptyRecord, loadOwner, saveOwner } from "@/lib/owner-record";
import { usageLabel } from "@/lib/hid-usages";
import {
  applyOwnerRecord,
  getLedParam,
  getProfile,
  getSettings,
  getSwitchPreset,
  getSwitches,
  readKeymap,
  setKey,
  setLedFlagsSwapped,
  setLedParam,
  setProfile,
  setSideLight,
  setSwitchKey,
  setSwitchPreset,
  setSwitchTrial,
  type ConnectedDevice,
  type OwnerRecord,
  type SwitchSettings,
} from "@/lib/backend";
import {
  STEPS,
  clearWizard,
  codeForUsage,
  didNotTake,
  freshState,
  judgePress,
  loadWizard,
  pendingWrite,
  pickSwitchKey,
  plainUsage,
  pressTargets,
  remapChoices,
  sameTravel,
  saveWizard,
  sliceEntries,
  stepNumber,
  switchesLookReal,
  travelFloor,
  trueSwap,
  type ColourState,
  type PressTarget,
  type ProfileResult,
  type RemapChoice,
  type RemapState,
  type Step,
  type SwitchResult,
  type WizardState,
} from "@/lib/wizard";

type Commit = (patch: Partial<OwnerRecord>) => Promise<OwnerRecord>;

const MAX_PROFILES = 8;

/** Steps during which an unplug is the board wedging rather than the owner
 *  leaving. */
const RUNNING: Step[] = ["board", "family", "keys", "colours", "profiles", "remap", "switches"];

const STEP_TITLES: Record<Step, string> = {
  start: "Before you start",
  board: "Your keyboard",
  family: "Command set",
  keys: "Keys",
  colours: "Colours",
  profiles: "Profiles",
  remap: "One remap",
  switches: "Switches",
  done: "Done",
};

export default function CheckPage({
  device,
  onContribute,
  onRescan,
}: {
  device: ConnectedDevice | null;
  onContribute: () => void;
  onRescan: () => void;
}) {
  const id = device?.spec.id;
  const [held, setHeld] = useState<{ id: number; s: WizardState } | null>(null);
  const state = held?.s ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [back, setBack] = useState(false);
  const lay = useBoardLayout(device);
  /** The running profile and its keymap, read for the keys and remap steps. */
  const [keymap, setKeymap] = useState<{ profile: number; entries: Map<number, number[]> } | null>(null);
  const [keymapError, setKeymapError] = useState<string | null>(null);
  const lastId = useRef<number | null>(null);
  const unplugged = useRef(false);

  // Load the run for this board; count a replug when the same board comes
  // back after leaving mid-run. StrictMode runs this twice on mount, which
  // is harmless: the second pass sees the same id and does nothing.
  useEffect(() => {
    if (id === undefined) {
      if (lastId.current !== null) {
        const s = loadWizard(lastId.current);
        unplugged.current = !!s && RUNNING.includes(s.step);
      }
      lastId.current = null;
      setHeld(null);
      setKeymap(null);
      setError(null);
      return;
    }
    if (lastId.current === id) return;
    const loaded = loadWizard(id) ?? freshState();
    if (unplugged.current && RUNNING.includes(loaded.step)) {
      loaded.replugs += 1;
      setBack(true);
    }
    unplugged.current = false;
    lastId.current = id;
    setHeld({ id, s: loaded });
    setKeymap(null);
    setError(null);
  }, [id]);

  useEffect(() => {
    if (held && held.id === id) saveWizard(held.id, held.s);
  }, [id, held]);

  const patch = useCallback((p: Partial<WizardState>) => {
    setHeld((h) => (h ? { ...h, s: { ...h.s, ...p } } : h));
  }, []);

  const go = (step: Step) => {
    setError(null);
    setBack(false);
    patch({ step });
  };

  const pending = state ? pendingWrite(state) : null;

  const startOver = () => {
    if (id === undefined || pending) return;
    clearWizard(id);
    // A trial opened for a test that was abandoned goes back to what is saved.
    applyOwnerRecord(loadOwner(id) ?? emptyRecord()).catch(() => {});
    setSwitchTrial(null).catch(() => {});
    setError(null);
    setBack(false);
    setKeymap(null);
    setHeld({ id, s: freshState() });
  };

  // The keys and remap steps work from the board's own keymap. A read, so
  // an effect is fine.
  const step = state?.step;
  useEffect(() => {
    if (!device || keymap || (step !== "keys" && step !== "remap")) return;
    let live = true;
    setKeymapError(null);
    (async () => {
      try {
        let profile = 0;
        try {
          const p = await getProfile();
          if (p < MAX_PROFILES) profile = p;
        } catch {
          // Profile 1 is where an unreadable board almost certainly is.
        }
        const matrix = await readKeymap(profile);
        if (live) setKeymap({ profile, entries: sliceEntries(matrix) });
      } catch (e) {
        if (live) setKeymapError(String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [device, keymap, step]);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!device) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
        <p className="text-base font-medium text-foreground">{t("Connect a keyboard by cable.")}</p>
        <p className="text-sm">
          {lastId.current === null && unplugged.current
            ? t("Setup carries on from where it was when the keyboard is back.")
            : t("Setup runs over the cable only.")}
        </p>
      </div>
    );
  }

  if (device.link === "receiver") {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <PageHeader title={t("Setup")} />
        <Banner>
          <p className="font-medium">{t("Setup runs over the cable only.")}</p>
          <p className="mt-0.5 text-muted-foreground">
            {t("Your keyboard is connected through its 2.4 GHz receiver. Setup needs the cable: some receivers carry no settings at all, and none is trusted for writes. Plug in the cable and come back.")}
          </p>
        </Banner>
      </div>
    );
  }

  if (!state) return null;

  const spec = device.spec;
  const label = deviceLabel(spec);
  const family = spec.family ?? "unknown";
  const known = family === "gen2" || family === "yc500";

  // The owner record is what makes an unregistered board work between
  // sessions: saved by device id, applied to the backend now and on every
  // connect. Applying sends nothing to the board.
  const commitOwner: Commit = async (p) => {
    const record = { ...(loadOwner(spec.id) ?? emptyRecord()), ...p };
    saveOwner(spec.id, record);
    await applyOwnerRecord(record);
    onRescan();
    return record;
  };
  // Applied for the length of a test, never saved: the saved answer is
  // whatever the test proves.
  const trialOwner: Commit = async (p) => {
    const record = { ...(loadOwner(spec.id) ?? emptyRecord()), ...p };
    await applyOwnerRecord(record);
    onRescan();
    return record;
  };

  // The record re-applies on connect, so this shows only when it was never
  // given, or storage was blocked.
  const needsGrant = device.readOnly && spec.unregistered;
  const grant = needsGrant && (
    <Banner>
      <p>{t("Changes to this keyboard are not allowed yet.")}</p>
      <Button
        size="sm"
        className="mt-2"
        onClick={() => run(async () => void (await commitOwner({ allowed: true })))}
        disabled={busy}
      >
        {t("Allow changes")}
      </Button>
    </Banner>
  );

  const stepNav = (
    <>
      <span className="text-sm text-muted-foreground">
        {t("Step {n} of {of}", { n: stepNumber(state.step), of: STEPS.length })}
      </span>
      {state.step !== "start" && state.step !== "done" && (
        <Button
          size="sm"
          variant="ghost"
          onClick={startOver}
          disabled={busy || !!pending}
          title={pending ? t("Not while {what}.", { what: t(pending) }) : undefined}
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" /> {t("Start over")}
        </Button>
      )}
    </>
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <PageHeader title={t("Setup")} hint={label}>
        {stepNav}
      </PageHeader>

      {back && (
        <Banner>
          {t("The keyboard is back. Carrying on from where setup was.")}{" "}
          <span className="text-muted-foreground">
            {t("{n} replugs so far.", { n: state.replugs })}
          </span>
        </Banner>
      )}

      {error && (
        <Banner className="bg-destructive/10">
          <p className="font-medium">{t("The keyboard did not take that.")}</p>
          <p className="mt-0.5 break-words text-muted-foreground">{error}</p>
          <p className="mt-1 text-muted-foreground">
            {t("If it has stopped answering: unplug it, wait ten seconds, plug it back in. Setup carries on from here.")}
          </p>
        </Banner>
      )}

      <Section title={t(STEP_TITLES[state.step])}>
        {state.step === "start" && (
          <div className="space-y-3 text-sm">
            <p>
              {t("If your keyboard already does what you want on the other tabs, you do not need this. Setup is for a board sharkfin does not know, or one that behaves oddly.")}
            </p>
            <p>
              <strong>{t("Cable only.")}</strong>{" "}
              {t("Setup runs over the cable, always. Some 2.4 GHz receivers carry no settings at all, so setup refuses to run over any receiver.")}
            </p>
            <p>
              {t("Setup reads your keyboard first. Then it writes a colour, switches profile and back, and remaps one key you choose. Where the keyboard has them it also writes red to the edge light and sets one switch to a light touch. It puts everything back itself except the key, which is yours to keep or undo.")}
            </p>
            {spec.unregistered && (
              <p>
                {t("sharkfin has no entry for this keyboard, so setup also asks a few questions and counts the profiles by switching through them. What you answer is kept for this keyboard and makes it work on this computer.")}
              </p>
            )}
            <p>
              {t("These writes land in the keyboard's own settings memory. Unplugging does not undo them.")}
            </p>
            <p>
              {t("If the keyboard stops answering, unplug it, wait ten seconds and plug it back in. Setup carries on from where it was.")}
            </p>
            <Button onClick={() => go("board")}>{t("Start")}</Button>
          </div>
        )}

        {state.step === "board" && (
          <div className="space-y-4">
            <p className="text-sm">{label}</p>
            {lay.resolving ? (
              <div className="flex h-40 items-center justify-center">
                <Waiting label={t("Finding your keyboard…")} />
              </div>
            ) : lay.layout.grid ? (
              <p className="text-sm text-muted-foreground">{t("No picture of this keyboard on file.")}</p>
            ) : (
              <KeyboardView
                layout={lay.layout}
                selected={null}
                entries={new Map()}
                modified={new Set()}
                labelFor={(k) => k.text ?? k.code}
                onSelect={() => {}}
              />
            )}
            <p className="text-sm font-medium">{t("Is this your keyboard?")}</p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={lay.resolving}
                onClick={() => {
                  patch({ boardOk: "yes" });
                  go("family");
                }}
              >
                {t("Yes")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={lay.resolving}
                onClick={() => {
                  patch({ boardOk: "no" });
                  // Another stored picture may fit; the last no gives up
                  // on them, the same as on the Keys tab.
                  if (lay.pending) lay.reject();
                  else go("family");
                }}
              >
                {lay.pending && lay.remaining > 0
                  ? t("No, show the next picture ({n} left)", { n: lay.remaining })
                  : t("No")}
              </Button>
            </div>
            {state.boardOk === "no" && !lay.pending && (
              <p className="text-sm text-muted-foreground">
                {t("The Keys tab can try other pictures or let you draw the board. Setup goes on; the key presses will show where the picture is wrong.")}
              </p>
            )}
          </div>
        )}

        {state.step === "family" && (
          <div className="space-y-3 text-sm">
            {!known ? (
              <>
                <p>
                  {t("sharkfin does not know which command set this keyboard speaks. It writes nothing to a board like that, so setup stops here.")}
                </p>
                <Button
                  onClick={() => {
                    patch({ stopped: true, allowed: "no" });
                    go("done");
                  }}
                >
                  {t("Finish and see the report")}
                </Button>
              </>
            ) : spec.unregistered ? (
              <>
                <p>
                  {t("Your keyboard answered as a {family} board. That is the board's own word: sharkfin has no entry for it yet.", { family })}
                </p>
                <p className="font-medium">
                  {t("Does this keyboard have magnetic switches, with an actuation point you can set?")}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={state.magnetic === "yes" ? "default" : "outline"}
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        // The answer changes how this family addresses its
                        // keymap pages, so it is checked before it is kept:
                        // a board with the switches answers the columns read
                        // with travel values, a board without does not.
                        await trialOwner({ magnetic: true });
                        let real = false;
                        try {
                          real = switchesLookReal(await getSwitches());
                        } catch {
                          real = false;
                        }
                        await commitOwner({ magnetic: real });
                        patch({ magnetic: "yes", magneticVerified: real });
                      })
                    }
                  >
                    {t("Yes")}
                  </Button>
                  <Button
                    size="sm"
                    variant={state.magnetic === "no" ? "default" : "outline"}
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await commitOwner({ magnetic: false });
                        patch({ magnetic: "no", magneticVerified: null });
                      })
                    }
                  >
                    {t("No")}
                  </Button>
                </div>
                {state.magnetic === "yes" && (
                  <p className="text-muted-foreground">
                    {state.magneticVerified
                      ? t("The keyboard's switch settings read as travel values, so that is kept.")
                      : t("The keyboard's switch settings did not read as travel values, so setup treats it as a keyboard without magnetic switches.")}
                  </p>
                )}
                {device.readOnly ? (
                  <>
                    <p className="text-muted-foreground">
                      {t("The rest of setup writes to the keyboard, so it needs your go. Your go is kept for this keyboard.")}
                    </p>
                    <Button
                      disabled={busy || state.magnetic === null}
                      onClick={() =>
                        run(async () => {
                          await commitOwner({ allowed: true });
                          patch({ allowed: "check" });
                          go("keys");
                        })
                      }
                    >
                      {t("Allow changes and continue")}
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="text-muted-foreground">{t("Changes are already allowed.")}</p>
                    <Button
                      disabled={state.magnetic === null}
                      onClick={() => {
                        patch({ allowed: state.allowed ?? "already" });
                        go("keys");
                      }}
                    >
                      {t("Continue")}
                    </Button>
                  </>
                )}
              </>
            ) : (
              <>
                <p>{t("This board is on file as speaking the {family} command set.", { family })}</p>
                <Button
                  onClick={() => {
                    patch({ allowed: "already" });
                    go("keys");
                  }}
                >
                  {t("Continue")}
                </Button>
              </>
            )}
          </div>
        )}

        {state.step === "keys" && (
          <KeysStep
            device={device}
            lay={lay}
            boardOk={state.boardOk}
            keymap={keymap}
            keymapError={keymapError}
            onDone={(picture) => {
              patch({ picture });
              go("colours");
            }}
          />
        )}

        {state.step === "colours" && (
          <ColoursStep
            device={device}
            colour={state.colour}
            edgeClaim={state.edgeClaim}
            busy={busy}
            grant={grant}
            run={run}
            commitOwner={commitOwner}
            setColour={(colour) => patch({ colour })}
            setEdgeClaim={(edgeClaim) => patch({ edgeClaim })}
            onDone={() => go("profiles")}
          />
        )}

        {state.step === "profiles" && (
          <ProfilesStep
            device={device}
            result={state.profiles}
            probe={!!spec.unregistered && loadOwner(spec.id)?.profiles == null}
            busy={busy}
            grant={grant}
            run={run}
            commitOwner={commitOwner}
            setResult={(profiles) => patch({ profiles })}
            onDone={() => {
              setKeymap(null);
              go("remap");
            }}
          />
        )}

        {state.step === "remap" && (
          <RemapStep
            readOnly={device.readOnly}
            keymap={keymap}
            keymapError={keymapError}
            remap={state.remap}
            busy={busy}
            grant={grant}
            run={run}
            setRemap={(remap) => patch({ remap })}
            onDone={() => go("switches")}
          />
        )}

        {state.step === "switches" && (
          <SwitchesStep
            device={device}
            keymap={keymap}
            result={state.switches}
            busy={busy}
            grant={grant}
            run={run}
            commitOwner={commitOwner}
            setResult={(switches) => patch({ switches })}
            onDone={() => go("done")}
          />
        )}

        {state.step === "done" && (
          <DoneStep
            device={device}
            state={state}
            onContribute={onContribute}
            onDecline={(declined) => patch({ declined })}
            onAgain={startOver}
          />
        )}
      </Section>
    </div>
  );
}

function KeysStep({
  device,
  lay,
  boardOk,
  keymap,
  keymapError,
  onDone,
}: {
  device: ConnectedDevice;
  lay: ReturnType<typeof useBoardLayout>;
  boardOk: WizardState["boardOk"];
  keymap: { profile: number; entries: Map<number, number[]> } | null;
  keymapError: string | null;
  onDone: (picture: WizardState["picture"]) => void;
}) {
  const [targets, setTargets] = useState<PressTarget[] | null>(null);
  const [results, setResults] = useState<{ target: PressTarget; ok: boolean; sent: string }[]>([]);
  const [finished, setFinished] = useState(false);
  const layoutName = lay.inference?.layoutName ?? device.spec.keyLayout;

  // Targets follow the picture: a new picture restarts the test.
  useEffect(() => {
    if (lay.resolving) return;
    setTargets(pressTargets(lay.layout, keymap?.entries));
    setResults([]);
    setFinished(false);
  }, [lay.layout, lay.resolving, keymap]);

  const current = targets && !finished ? targets[results.length] : undefined;

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      const j = judgePress(current, e.code);
      setResults((r) => [...r, { target: current, ...j }]);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [current]);

  useEffect(() => {
    if (targets && results.length === targets.length && targets.length > 0) setFinished(true);
  }, [targets, results]);

  if (lay.resolving || targets === null || (!keymap && !keymapError && !lay.layout.grid)) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Waiting label={t("Reading the keymap…")} />
      </div>
    );
  }

  if (lay.layout.grid || !targets || targets.length === 0) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          {lay.layout.grid
            ? t("No picture of this keyboard on file, so there is nothing to press against.")
            : keymapError
              ? t("The keymap could not be read: {e}", { e: keymapError })
              : t("The picture names no key that can be pressed here.")}
        </p>
        <Button onClick={() => onDone(lay.layout.grid ? "none" : "skipped")}>{t("Continue")}</Button>
      </div>
    );
  }

  const misses = results.filter((r) => !r.ok);
  const matched = new Set(results.filter((r) => r.ok).map((r) => r.target.slot));
  const picture = {
    layout: layoutName,
    pressed: results.length - misses.length,
    of: targets.length,
    misses: misses.map((m) => t("the key marked {a} sent {b}", { a: m.target.label, b: m.sent })),
  };

  return (
    <div className="space-y-4">
      <p className="text-sm">
        {current
          ? t("Press the highlighted key: {key}. {n} keys, one at a time.", { key: current.label, n: targets.length })
          : misses.length
            ? t("{n} of {of} keys sent what the picture says.", { n: picture.pressed, of: picture.of })
            : t("All {of} keys sent what the picture says.", { of: picture.of })}
      </p>
      <KeyboardView
        layout={lay.layout}
        selected={current?.slot ?? null}
        entries={keymap?.entries ?? new Map()}
        modified={matched}
        labelFor={(k) => k.text ?? k.code}
        onSelect={() => {}}
      />
      {misses.length > 0 && (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {picture.misses.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {current ? (
          <Button size="sm" variant="ghost" onClick={() => onDone("skipped")}>
            {t("Skip")}
          </Button>
        ) : lay.pending && misses.length === 0 && boardOk !== "no" ? (
          <>
            <span className="mr-2 text-sm font-medium">{t("Use this picture for your board?")}</span>
            <Button
              size="sm"
              onClick={() => {
                lay.confirm();
                onDone(picture);
              }}
            >
              {t("Yes")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDone(picture)}>
              {t("Not yet")}
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => onDone(picture)}>
            {t("Continue")}
          </Button>
        )}
        {!current && lay.pending && (
          <Button size="sm" variant="ghost" onClick={lay.reject}>
            {lay.remaining > 0
              ? t("Try the next picture ({n} left)", { n: lay.remaining })
              : t("This picture is wrong")}
          </Button>
        )}
      </div>
    </div>
  );
}

function ColoursStep({
  device,
  colour,
  edgeClaim,
  busy,
  grant,
  run,
  commitOwner,
  setColour,
  setEdgeClaim,
  onDone,
}: {
  device: ConnectedDevice;
  colour: ColourState | null;
  edgeClaim: WizardState["edgeClaim"];
  busy: boolean;
  grant: React.ReactNode;
  run: (f: () => Promise<void>) => Promise<void>;
  commitOwner: Commit;
  setColour: (c: ColourState) => void;
  setEdgeClaim: (c: WizardState["edgeClaim"]) => void;
  onDone: () => void;
}) {
  const [ledOff, setLedOff] = useState(false);
  const spec = device.spec;
  const dflt = spec.ledFlagsSwapped ?? false;
  const brightness = Math.max(1, Math.min(4, spec.light?.brightnessMax ?? 4));

  const turnRed = () =>
    run(async () => {
      const settings = await getSettings().catch(() => null);
      if (settings?.options?.ledOff) {
        setLedOff(true);
        return;
      }
      // The reading decides how a reply is decoded as well as how a packet
      // is encoded, so it goes in before the first read. Both readings of
      // the current lighting are kept: whichever the board turns out to
      // have is the one written back, as the bytes it came from.
      const sw = effectiveSwap(spec.id, dflt);
      await setLedFlagsSwapped(false);
      const plain = await getLedParam();
      await setLedFlagsSwapped(true);
      const swapped = await getLedParam();
      await setLedFlagsSwapped(sw);
      let c: ColourState = {
        sw,
        originals: { plain, swapped },
        written: false,
        readBack: null,
        answer: null,
        restored: null,
        restoredReadBack: null,
        sideOriginal: null,
        sideWritten: false,
        edge: null,
        sideRestored: null,
      };
      setColour(c);
      const current = sw ? swapped : plain;
      await setLedParam({
        mode: 1,
        speed: current.speed,
        brightness,
        option: 0,
        dazzle: false,
        r: 255,
        g: 0,
        b: 0,
      });
      c = { ...c, written: true };
      setColour(c);
      try {
        const after = await getLedParam();
        c = { ...c, readBack: after.mode === 1 };
      } catch {
        c = { ...c, readBack: false };
      }
      setColour(c);
    });

  const restore = async (c: ColourState): Promise<ColourState> => {
    if (!c.originals) return c;
    const truth =
      c.answer === "solid" || c.answer === "cycling" ? trueSwap(c.sw, c.answer) : c.sw;
    try {
      await setLedFlagsSwapped(truth);
      const want = truth ? c.originals.swapped : c.originals.plain;
      await setLedParam(want);
      if (c.answer === "cycling")
        writeChoice(spec.id, truth !== dflt ? { swapped: truth, dflt } : null);
      let restoredReadBack: boolean | null = null;
      try {
        const got = await getLedParam();
        restoredReadBack = (["mode", "speed", "brightness", "option", "dazzle", "r", "g", "b"] as const).every(
          (k) => got[k] === want[k],
        );
      } catch {
        restoredReadBack = false;
      }
      return { ...c, restored: true, restoredReadBack };
    } catch (e) {
      setColour({ ...c, restored: false });
      throw e;
    }
  };

  const answer = (a: "solid" | "cycling" | "neither") =>
    run(async () => {
      if (!colour) return;
      const c = { ...colour, answer: a };
      setColour(c);
      setColour(await restore(c));
    });

  const lightEdge = () =>
    run(async () => {
      if (!colour) return;
      const settings = await getSettings();
      const side = settings.sideLight;
      if (!side) throw new Error(t("the keyboard did not answer for its edge light"));
      let c: ColourState = { ...colour, sideOriginal: side };
      setColour(c);
      await setSideLight({
        mode: 1,
        speed: side.speed,
        brightness: 4,
        option: 0,
        dazzle: false,
        r: 255,
        g: 0,
        b: 0,
      });
      c = { ...c, sideWritten: true };
      setColour(c);
    });

  const answerEdge = (edge: "yes" | "no") =>
    run(async () => {
      if (!colour || !colour.sideOriginal) return;
      const c: ColourState = { ...colour, edge };
      setColour(c);
      try {
        await setSideLight(colour.sideOriginal);
        setColour({ ...c, sideRestored: true });
      } catch (e) {
        setColour({ ...c, sideRestored: false });
        throw e;
      }
      // The firmware answers the edge-light read whether or not the
      // hardware exists; on a board the registry does not know, what the
      // owner saw is the only evidence.
      if (spec.unregistered) await commitOwner({ sideLight: edge === "yes" });
    });

  const claimEdge = (claim: "yes" | "no") =>
    run(async () => {
      await commitOwner({ sideLight: claim === "yes" });
      setEdgeClaim(claim);
    });

  // Registered boards take the registry's word. An unregistered one has no
  // word to take, so the owner is asked first and the red test settles it.
  const askEdge = !!spec.unregistered && !spec.features.sideLight && edgeClaim === null;
  const hasEdge = !!spec.features.sideLight || edgeClaim === "yes";
  const edgeDone = !askEdge && (!hasEdge || colour?.sideRestored === true);

  if (ledOff) {
    return (
      <div className="space-y-3 text-sm">
        <p>
          {t("The backlight is switched off on this keyboard, so a colour would not show. Turn it on from the Lighting tab and come back, or skip this step.")}
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setLedOff(false)} disabled={busy}>
            {t("Try again")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone}>
            {t("Skip")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 text-sm">
      {grant}
      {!colour?.written ? (
        <>
          <p>
            {t("Setup writes one solid red to the backlight, asks what you see, then puts your lighting back.")}
          </p>
          <div className="flex gap-2">
            <Button onClick={turnRed} disabled={busy || device.readOnly}>
              {busy ? t("Writing…") : t("Turn the board red")}
            </Button>
            <Button variant="ghost" onClick={onDone} disabled={busy}>
              {t("Skip")}
            </Button>
          </div>
        </>
      ) : colour.answer === null ? (
        <>
          <p className="font-medium">{t("What does the backlight show now?")}</p>
          <p className="text-muted-foreground">
            {t("Look at the keys as a whole. If the Del key alone is blue or green, ignore it: on many boards it shows the battery's charge, or it is a fixed indicator. Nothing changes that.")}
          </p>
          {colour.readBack === false && (
            <p className="text-muted-foreground">{t("The keyboard did not read the write back.")}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => answer("solid")} disabled={busy}>
              {t("Solid red")}
            </Button>
            <Button size="sm" onClick={() => answer("cycling")} disabled={busy}>
              {t("Cycling through colours")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => answer("neither")} disabled={busy}>
              {t("Neither")}
            </Button>
          </div>
        </>
      ) : colour.restored !== true ? (
        <>
          <p>{busy ? t("Putting your lighting back…") : t("Your lighting has not been put back yet.")}</p>
          {!busy && (
            <Button size="sm" onClick={() => run(async () => setColour(await restore(colour)))}>
              {t("Put the colour back")}
            </Button>
          )}
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            {colour.answer === "cycling"
              ? t("Your keyboard reads the rainbow flag the other way round. The Lighting tab now knows.")
              : colour.answer === "solid"
                ? t("Your keyboard reads the rainbow flag as sharkfin expected.")
                : t("No change was seen.")}{" "}
            {colour.restoredReadBack === false
              ? t("Your lighting went back out but did not read back the same.")
              : t("Your lighting is back.")}
          </p>
          {askEdge && (
            <>
              <p className="font-medium">
                {t("Does this keyboard have lights along its sides or underside, apart from the keys?")}
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => claimEdge("yes")} disabled={busy}>
                  {t("Yes")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => claimEdge("no")} disabled={busy}>
                  {t("No")}
                </Button>
              </div>
            </>
          )}
          {hasEdge && !colour.sideWritten && (
            <>
              <p>{t("This keyboard has an edge light. Setup writes red to it, asks, and puts it back.")}</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={lightEdge} disabled={busy || device.readOnly}>
                  {busy ? t("Writing…") : t("Light the edge red")}
                </Button>
                <Button size="sm" variant="ghost" onClick={onDone} disabled={busy}>
                  {t("Skip")}
                </Button>
              </div>
            </>
          )}
          {hasEdge && colour.sideWritten && colour.edge === null && (
            <>
              <p className="font-medium">{t("Are the lights along the sides red now?")}</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => answerEdge("yes")} disabled={busy}>
                  {t("Yes")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => answerEdge("no")} disabled={busy}>
                  {t("No")}
                </Button>
              </div>
            </>
          )}
          {hasEdge && colour.edge !== null && colour.sideRestored !== true && (
            <>
              <p>{busy ? t("Putting the edge light back…") : t("The edge light has not been put back yet.")}</p>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    if (!colour.sideOriginal) return;
                    await setSideLight(colour.sideOriginal);
                    setColour({ ...colour, sideRestored: true });
                  })
                }
              >
                {t("Put the edge light back")}
              </Button>
            </>
          )}
          {edgeDone && (
            <Button size="sm" onClick={onDone} disabled={busy}>
              {t("Continue")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function ProfilesStep({
  device,
  result,
  probe,
  busy,
  grant,
  run,
  commitOwner,
  setResult,
  onDone,
}: {
  device: ConnectedDevice;
  result: WizardState["profiles"];
  /** The registry has no count for this board: find it by switching. */
  probe: boolean;
  busy: boolean;
  grant: React.ReactNode;
  run: (f: () => Promise<void>) => Promise<void>;
  commitOwner: Commit;
  setResult: (r: WizardState["profiles"]) => void;
  onDone: () => void;
}) {
  const count = Math.min(MAX_PROFILES, Math.max(1, device.spec.profiles));
  const r = result === "one" ? null : result;

  // Profiles 2 to 4 are tried in turn; the first that does not take ends
  // the count. Boards with more than four exist but are rare, and every
  // try is a flash write, so the probe stops there and says so.
  const find = () =>
    run(async () => {
      const res: ProfileResult = { count: 1, found: null, from: null, verified: false, away: false, error: null };
      try {
        const cur = await getProfile();
        if (cur >= MAX_PROFILES) throw new Error(t("the profile read came back as {n}", { n: cur }));
        res.from = cur;
        let n = cur + 1;
        for (const k of [1, 2, 3]) {
          if (k === cur) continue;
          try {
            await setProfile(k);
          } catch (e) {
            // The board refusing the profile is the count; anything else
            // is the write failing, and no count is kept from that.
            if (didNotTake(e)) break;
            throw e;
          }
          res.away = true;
          n = Math.max(n, k + 1);
          setResult({ ...res, count: n });
        }
        await setProfile(cur);
        res.away = false;
        res.verified = true;
        res.count = n;
        res.found = n;
      } catch (e) {
        res.error = String(e);
      }
      setResult(res);
      if (res.error) throw new Error(res.error);
      await commitOwner({ profiles: res.count });
    });

  if (probe && !r) {
    return (
      <div className="space-y-4 text-sm">
        {grant}
        <p>
          {t("sharkfin does not know how many profiles this keyboard has. Setup switches through them and back to find out, and reads the profile after each switch.")}
        </p>
        <div className="flex gap-2">
          <Button onClick={find} disabled={busy || device.readOnly}>
            {busy ? t("Switching…") : t("Find the profiles")}
          </Button>
          <Button variant="ghost" onClick={onDone} disabled={busy}>
            {t("Skip")}
          </Button>
        </div>
      </div>
    );
  }

  if (count === 1 && !r) {
    return (
      <div className="space-y-3 text-sm">
        <p>{t("This keyboard has one profile, so there is nothing to switch.")}</p>
        <Button
          size="sm"
          onClick={() => {
            setResult("one");
            onDone();
          }}
        >
          {t("Continue")}
        </Button>
      </div>
    );
  }

  const switchAndBack = () =>
    run(async () => {
      const res: ProfileResult = { count, found: null, from: null, verified: false, away: false, error: null };
      try {
        const cur = await getProfile();
        if (cur >= MAX_PROFILES) throw new Error(t("the profile read came back as {n}", { n: cur }));
        res.from = cur;
        await setProfile((cur + 1) % count);
        res.away = true;
        setResult({ ...res });
        await setProfile(cur);
        res.away = false;
        res.verified = true;
      } catch (e) {
        res.error = String(e);
      }
      setResult(res);
      if (res.error) throw new Error(res.error);
    });

  const switchBack = () =>
    run(async () => {
      if (result === null || result === "one" || result.from === null) return;
      const res = { ...result };
      try {
        await setProfile(result.from);
        res.away = false;
      } catch (e) {
        res.error = String(e);
        setResult(res);
        throw e;
      }
      setResult(res);
    });

  return (
    <div className="space-y-4 text-sm">
      {grant}
      {!r ? (
        <>
          <p>
            {t("This keyboard has {n} profiles. Setup switches to the next one and back again, and reads the profile after each switch.", { n: count })}
          </p>
          <div className="flex gap-2">
            <Button onClick={switchAndBack} disabled={busy || device.readOnly}>
              {busy ? t("Switching…") : t("Switch and back")}
            </Button>
            <Button variant="ghost" onClick={onDone} disabled={busy}>
              {t("Skip")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>
            {r.verified && r.found !== null
              ? t("{n} profiles found. The keyboard is on the profile it started on.", { n: r.found })
              : r.verified
              ? t("Both switches read back. The keyboard is on the profile it started on.")
              : r.away
                ? t("The switch away worked, the switch back did not. The keyboard is on another profile.")
                : t("The switch did not read back.")}
          </p>
          <div className="flex flex-wrap gap-2">
            {r.away && (
              <Button size="sm" onClick={switchBack} disabled={busy || device.readOnly}>
                {t("Switch back")}
              </Button>
            )}
            {!r.verified && !r.away && (
              <Button size="sm" onClick={probe ? find : switchAndBack} disabled={busy || device.readOnly}>
                {t("Try again")}
              </Button>
            )}
            <Button size="sm" variant={r.verified ? "default" : "ghost"} onClick={onDone} disabled={busy}>
              {t("Continue")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function RemapStep({
  readOnly,
  keymap,
  keymapError,
  remap,
  busy,
  grant,
  run,
  setRemap,
  onDone,
}: {
  readOnly: boolean;
  keymap: { profile: number; entries: Map<number, number[]> } | null;
  keymapError: string | null;
  remap: RemapState | null;
  busy: boolean;
  grant: React.ReactNode;
  run: (f: () => Promise<void>) => Promise<void>;
  setRemap: (r: RemapState) => void;
  onDone: () => void;
}) {
  const awaitingPress = !!remap && remap.written && remap.pressed === null;

  useEffect(() => {
    if (!awaitingPress || !remap) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      setRemap({ ...remap, pressed: e.code === codeForUsage(remap.to) });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [awaitingPress, remap, setRemap]);

  const readSlot = async (profile: number, slot: number) => {
    const m = await readKeymap(profile);
    return plainUsage(m.slice(slot * 4, slot * 4 + 4));
  };

  const write = (choice: RemapChoice) =>
    run(async () => {
      if (!keymap) return;
      let r: RemapState = {
        profile: keymap.profile,
        slot: choice.slot,
        from: choice.from,
        to: choice.to,
        written: false,
        readBack: null,
        pressed: null,
        kept: null,
        undoReadBack: null,
      };
      setRemap(r);
      await setKey(r.profile, r.slot, [0, 0, r.to, 0], false);
      r = { ...r, written: true };
      setRemap(r);
      try {
        r = { ...r, readBack: (await readSlot(r.profile, r.slot)) === r.to };
      } catch {
        r = { ...r, readBack: false };
      }
      setRemap(r);
    });

  const undo = () =>
    run(async () => {
      if (!remap) return;
      let r: RemapState;
      try {
        await setKey(remap.profile, remap.slot, [0, 0, remap.from, 0], false);
        r = { ...remap, kept: "undone" };
      } catch (e) {
        setRemap({ ...remap, kept: "undo failed" });
        throw e;
      }
      setRemap(r);
      try {
        r = { ...r, undoReadBack: (await readSlot(r.profile, r.slot)) === r.from };
      } catch {
        r = { ...r, undoReadBack: false };
      }
      setRemap(r);
    });

  if (!remap || !remap.written) {
    if (!keymap && !keymapError) {
      return (
        <div className="flex h-40 items-center justify-center">
          <Waiting label={t("Reading the keymap…")} />
        </div>
      );
    }
    const choices = keymap ? remapChoices(keymap.entries) : [];
    return (
      <div className="space-y-4 text-sm">
        {grant}
        {keymapError ? (
          <p className="text-muted-foreground">{t("The keymap could not be read: {e}", { e: keymapError })}</p>
        ) : choices.length === 0 ? (
          <p className="text-muted-foreground">
            {t("None of the keys setup knows how to remap sit where expected on this keyboard.")}
          </p>
        ) : (
          <>
            <p>
              {t("Pick one key to remap. Setup writes it, reads it back, and asks you to press it. You keep the change or undo it, your choice.")}
            </p>
            <div className="flex flex-wrap gap-2">
              {choices.map((c) => (
                <Button key={c.slot} size="sm" onClick={() => write(c)} disabled={busy || readOnly}>
                  {t(c.label)}
                </Button>
              ))}
            </div>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={onDone} disabled={busy}>
          {t("Skip")}
        </Button>
      </div>
    );
  }

  const fromLabel = usageLabel(remap.from);
  const toLabel = usageLabel(remap.to);

  return (
    <div className="space-y-4 text-sm">
      {grant}
      <p>
        {t("{from} now sends {to}.", { from: fromLabel, to: toLabel })}{" "}
        <span className="text-muted-foreground">
          {remap.readBack === true
            ? t("The write read back.")
            : remap.readBack === false
              ? t("The write did not read back.")
              : ""}
        </span>
      </p>
      {awaitingPress ? (
        <>
          <p className="font-medium">{t("Now press the {from} key.", { from: fromLabel })}</p>
          <Button size="sm" variant="ghost" onClick={() => setRemap({ ...remap, pressed: false })} disabled={busy}>
            {t("Skip the press")}
          </Button>
        </>
      ) : remap.kept === null ? (
        <>
          <p className="text-muted-foreground">
            {remap.pressed
              ? t("It sent {to}.", { to: toLabel })
              : t("It did not send {to}.", { to: toLabel })}
          </p>
          <p className="font-medium">{t("Keep this remap, or undo it?")}</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setRemap({ ...remap, kept: "kept" })} disabled={busy}>
              {t("Keep")}
            </Button>
            <Button size="sm" variant="ghost" onClick={undo} disabled={busy || readOnly}>
              {busy ? t("Writing…") : t("Undo")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            {remap.kept === "kept"
              ? t("Kept. You can change it any time on the Keys tab.")
              : remap.kept === "undone"
                ? remap.undoReadBack === false
                  ? t("Undone, but the undo did not read back.")
                  : t("Undone. {from} is {from} again.", { from: fromLabel })
                : t("The undo did not go through. {from} still sends {to}.", { from: fromLabel, to: toLabel })}
          </p>
          <div className="flex gap-2">
            {remap.kept === "undo failed" && (
              <Button size="sm" onClick={undo} disabled={busy || readOnly}>
                {t("Try the undo again")}
              </Button>
            )}
            <Button size="sm" onClick={onDone} disabled={busy}>
              {t("Continue")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function SwitchesStep({
  device,
  keymap,
  result,
  busy,
  grant,
  run,
  commitOwner,
  setResult,
  onDone,
}: {
  device: ConnectedDevice;
  keymap: { profile: number; entries: Map<number, number[]> } | null;
  result: WizardState["switches"];
  busy: boolean;
  grant: React.ReactNode;
  run: (f: () => Promise<void>) => Promise<void>;
  commitOwner: Commit;
  setResult: (r: WizardState["switches"]) => void;
  onDone: () => void;
}) {
  const spec = device.spec;
  const access = device.switches;
  const [settings, setSettings] = useState<SwitchSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const r = result === "none" ? null : result;

  // The columns are a raw page read with no side effects.
  useEffect(() => {
    if (access === "none" || settings) return;
    let live = true;
    getSwitches()
      .then((s) => live && setSettings(s))
      .catch((e) => live && setLoadError(String(e)));
    return () => {
      live = false;
    };
  }, [access, settings]);

  if (access === "none" || access === "global") {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          {access === "global"
            ? t("This keyboard takes one switch record for every key and cannot report it back, so setup does not test it.")
            : spec.magnetic
              ? t("This keyboard's switch settings cannot be read, so there is nothing to test.")
              : t("This keyboard has no magnetic switches to test.")}
        </p>
        <Button
          size="sm"
          onClick={() => {
            setResult("none");
            onDone();
          }}
        >
          {t("Continue")}
        </Button>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t("The switch settings could not be read: {e}", { e: loadError })}</p>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t("Skip")}
        </Button>
      </div>
    );
  }

  if (!settings || !keymap) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Waiting label={t("Reading the switch settings…")} />
      </div>
    );
  }

  const pick = r ? { slot: r.slot, label: r.label } : pickSwitchKey(settings.keys, keymap.entries);
  if (!pick) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t("No plain key was found to feel the test on.")}</p>
        <Button
          size="sm"
          onClick={() => {
            setResult("none");
            onDone();
          }}
        >
          {t("Continue")}
        </Button>
      </div>
    );
  }

  const unit = settings.unitMm;
  const min = travelFloor(spec, unit);
  // After the light-touch write the columns read the changed key, so the
  // original travels with the result, not the read.
  const original = r?.original ?? settings.keys.find((k) => k.slot === pick.slot) ?? null;

  const readTravel = async () => {
    const s = await getSwitches();
    return s.keys.find((k) => k.slot === pick.slot)?.travel ?? null;
  };

  const setLight = () =>
    run(async () => {
      if (!original) throw new Error(t("the key's settings were not in the read"));
      // A lineage without firmware evidence is opened for this one slot,
      // for the length of the test. What gets saved is what the test proves.
      if (access !== "write") await setSwitchTrial(pick.slot);
      let w: SwitchResult = {
        slot: pick.slot,
        label: pick.label,
        original,
        min,
        preset: null,
        wroteMin: false,
        readBackMin: null,
        feltLight: null,
        restored: null,
        readBackRestore: null,
        feltNormal: null,
        presetRestored: null,
        unlocked: null,
      };
      if (settings.format === "yc500") w.preset = await getSwitchPreset().catch(() => null);
      setResult(w);
      await setSwitchKey({ ...original, travel: min });
      w = { ...w, wroteMin: true };
      setResult(w);
      try {
        const tr = await readTravel();
        w = { ...w, readBackMin: tr !== null && sameTravel(tr, min, unit) };
      } catch {
        w = { ...w, readBackMin: false };
      }
      setResult(w);
    });

  const putBack = async (w: SwitchResult): Promise<SwitchResult> => {
    const orig = w.original;
    if (!orig) return w;
    try {
      // The trial dies with the handle, so a replug mid-test needs it again.
      if (access !== "write") await setSwitchTrial(w.slot);
      await setSwitchKey(orig);
      w = { ...w, restored: true };
    } catch (e) {
      setResult({ ...w, restored: false });
      throw e;
    }
    setResult(w);
    try {
      const tr = await readTravel();
      w = { ...w, readBackRestore: tr !== null && sameTravel(tr, orig.travel, unit) };
    } catch {
      w = { ...w, readBackRestore: false };
    }
    // A yc500 write moves the board to its custom preset; the one it was
    // on goes back after the key does.
    if (w.preset !== null) {
      try {
        await setSwitchPreset(w.preset);
        w = { ...w, presetRestored: true };
      } catch {
        w = { ...w, presetRestored: false };
      }
    }
    setResult(w);
    return w;
  };

  const answerLight = (a: "yes" | "no") =>
    run(async () => {
      if (!r) return;
      const w = { ...r, feltLight: a };
      setResult(w);
      await putBack(w);
    });

  const answerNormal = (a: "yes" | "no") =>
    run(async () => {
      if (!r) return;
      const unlocked = r.readBackMin === true && r.feltLight === "yes" && r.readBackRestore !== false;
      setResult({ ...r, feltNormal: a, unlocked });
      await commitOwner({ switchWrites: unlocked });
      await setSwitchTrial(null);
    });

  return (
    <div className="space-y-4 text-sm">
      {grant}
      {!r || !r.wroteMin ? (
        <>
          <p>
            {t("This keyboard reports magnetic switches. Setup sets one key, {key}, to fire at the lightest touch, asks how it feels, then puts it back. Keep a finger ready on that key.", { key: pick.label })}
          </p>
          {access === "read" && (
            <p className="text-muted-foreground">
              {t("sharkfin has not read this keyboard's firmware for its switch settings. If the write reads back and you feel it, the Switches tab opens for this keyboard.")}
            </p>
          )}
          <div className="flex gap-2">
            <Button onClick={setLight} disabled={busy || device.readOnly}>
              {busy ? t("Writing…") : t("Set {key} to a light touch", { key: pick.label })}
            </Button>
            <Button variant="ghost" onClick={onDone} disabled={busy}>
              {t("Skip")}
            </Button>
          </div>
        </>
      ) : r.feltLight === null ? (
        <>
          <p className="text-muted-foreground">
            {r.readBackMin === true
              ? t("{key} is set to {mm} mm and read back.", { key: r.label, mm: r.min })
              : r.readBackMin === false
                ? t("The write to {key} did not read back.", { key: r.label })
                : ""}
          </p>
          <p className="font-medium">
            {t("Press {key} lightly. Does it fire before you push it all the way down?", { key: r.label })}
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => answerLight("yes")} disabled={busy}>
              {t("Yes")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => answerLight("no")} disabled={busy}>
              {t("No")}
            </Button>
          </div>
        </>
      ) : r.restored !== true ? (
        <>
          <p>{busy ? t("Putting {key} back…", { key: r.label }) : t("{key} has not been put back yet.", { key: r.label })}</p>
          {!busy && (
            <Button size="sm" onClick={() => run(async () => void (await putBack(r)))}>
              {t("Put the key back")}
            </Button>
          )}
        </>
      ) : r.feltNormal === null ? (
        <>
          <p className="text-muted-foreground">
            {r.readBackRestore === true
              ? t("{key} is back to {mm} mm and read back.", { key: r.label, mm: r.original?.travel ?? "" })
              : t("The restore of {key} did not read back.", { key: r.label })}
            {r.presetRestored === false && " " + t("The preset was not put back.")}
          </p>
          <p className="font-medium">
            {t("Press {key} again. Does it need a normal press now?", { key: r.label })}
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => answerNormal("yes")} disabled={busy}>
              {t("Yes")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => answerNormal("no")} disabled={busy}>
              {t("No")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            {r.unlocked
              ? t("The switch settings took and you felt them. The Switches tab is open for this keyboard.")
              : t("The switch settings did not prove out, so the Switches tab stays read-only for this keyboard.")}
          </p>
          <Button size="sm" onClick={onDone} disabled={busy}>
            {t("Continue")}
          </Button>
        </>
      )}
    </div>
  );
}

function DoneStep({
  device,
  state,
  onContribute,
  onDecline,
  onAgain,
}: {
  device: ConnectedDevice;
  state: WizardState;
  onContribute: () => void;
  onDecline: (declined: boolean) => void;
  onAgain: () => void;
}) {
  const spec = device.spec;
  const known = spec.family === "gen2" || spec.family === "yc500";
  const c = state.colour;
  const p = state.profiles;
  const r = state.remap;
  const w = state.switches;
  const pic = state.picture;

  type Mark = boolean | null;
  const rows: [string, Mark, string][] = [
    [
      t("Keyboard recognised"),
      state.boardOk === null ? null : state.boardOk === "yes",
      state.boardOk === null ? t("unanswered") : state.boardOk === "yes" ? deviceLabel(spec) : t("not the board shown"),
    ],
    [
      t("Command set"),
      known,
      known
        ? spec.unregistered
          ? t("{family}, the board's own word", { family: spec.family ?? "" })
          : t("{family}, on file", { family: spec.family ?? "" })
        : t("unknown, nothing written"),
    ],
    [
      t("Keys"),
      pic === null || pic === "skipped" || pic === "none" ? null : pic.misses.length === 0,
      pic === null
        ? t("not tested")
        : pic === "skipped"
          ? t("skipped")
          : pic === "none"
            ? t("no picture on file")
            : t("{n} of {of} keys pressed as pictured", { n: pic.pressed, of: pic.of }),
    ],
    [
      t("Colours"),
      !c || !c.written ? null : c.answer === "neither" ? false : c.restored === true,
      !c || !c.written
        ? t("not tested")
        : c.answer === "neither"
          ? t("no change seen")
          : c.answer === null
            ? t("unanswered")
            : c.restored === true
              ? c.answer === "cycling"
                ? t("rainbow flag the other way round, lighting put back")
                : t("as expected, lighting put back")
              : t("lighting not put back"),
    ],
    ...(spec.features.sideLight
      ? [
          [
            t("Edge light"),
            !c || !c.sideWritten || c.edge === null ? null : c.edge === "yes",
            !c || !c.sideWritten
              ? t("not tested")
              : c.edge === null
                ? t("unanswered")
                : (c.edge === "yes" ? t("red as asked") : t("did not go red")) +
                  (c.sideRestored === false ? t(", not put back") : ""),
          ] as [string, Mark, string],
        ]
      : []),
    [
      t("Profiles"),
      p === null ? null : p === "one" ? true : p.verified,
      p === null
        ? t("not tested")
        : p === "one"
          ? t("one profile, nothing to switch")
          : p.verified
            ? t("{n}, switch and back read back", { n: p.count })
            : p.away
              ? t("{n}, keyboard left on another profile", { n: p.count })
              : t("{n}, switch did not read back", { n: p.count }),
    ],
    [
      t("Remap"),
      !r || !r.written ? null : r.readBack === true && r.pressed !== false,
      !r || !r.written
        ? t("not tested")
        : t("{from} to {to}", { from: usageLabel(r.from), to: usageLabel(r.to) }) +
          ", " +
          (r.readBack ? t("read back") : t("not read back")) +
          ", " +
          (r.pressed === null ? t("press skipped") : r.pressed ? t("pressed") : t("press did not match")) +
          ", " +
          (r.kept === "kept" ? t("kept") : r.kept === "undone" ? t("undone") : r.kept === "undo failed" ? t("undo failed") : t("undecided")),
    ],
    ...(spec.unregistered
      ? [
          [
            t("Magnetic switches"),
            state.magnetic === null ? null : state.magnetic === "no" ? true : state.magneticVerified === true,
            state.magnetic === null
              ? t("unanswered")
              : state.magnetic === "no"
                ? t("no, your word")
                : state.magneticVerified
                  ? t("yes, and the switch settings read as travel")
                  : t("you said yes, but the switch settings did not read as travel; treated as no"),
          ] as [string, Mark, string],
        ]
      : []),
    [
      t("Switch settings"),
      w === null || w === "none" || !w.wroteMin ? null : w.unlocked === true,
      w === null
        ? t("not tested")
        : w === "none"
          ? t("none sharkfin can read")
          : !w.wroteMin
            ? t("not tested")
            : w.unlocked === null
              ? t("unanswered")
              : w.unlocked
                ? t("{key} took a light touch and went back; the Switches tab is open", { key: w.label })
                : t("{key} did not prove out; the Switches tab stays read-only", { key: w.label }),
    ],
    [
      t("Changes"),
      state.allowed === "no" ? false : state.allowed === null ? null : true,
      state.allowed === "check"
        ? t("allowed by setup")
        : state.allowed === "already"
          ? t("already allowed")
          : t("not allowed"),
    ],
  ];

  return (
    <div className="space-y-4 text-sm">
      {state.stopped && (
        <p className="text-muted-foreground">{t("Setup stopped at the command set. Nothing was written.")}</p>
      )}
      <table className="w-full">
        <tbody>
          {rows.map(([name, mark, note]) => (
            <tr key={name} className="border-t border-border/50">
              <td className="w-6 py-2">
                {mark === null ? (
                  <Minus className="h-4 w-4 text-muted-foreground" />
                ) : mark ? (
                  <Check className="h-4 w-4 text-(--key-accent)" />
                ) : (
                  <X className="h-4 w-4 text-destructive" />
                )}
              </td>
              <td className="py-2 pr-3 font-medium">{name}</td>
              <td className="py-2 text-muted-foreground">{note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {spec.unregistered && !state.stopped && state.boardOk !== "no" && !state.declined && (
        <p>
          {t("Your keyboard works from your answers now, on this computer. Send them in and it works for everyone with this keyboard, on every computer.")}
        </p>
      )}
      <p className="text-muted-foreground">
        {t("{n} replugs.", { n: state.replugs })}{" "}
        {t("The report rides along with the data bundle on the Contribute tab whenever you collect one.")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onContribute}>
          <Send className="mr-1 h-3.5 w-3.5" /> {t("Send the report")}
        </Button>
        {!state.declined && (
          <Button variant="ghost" onClick={() => onDecline(true)}>
            {t("Skip")}
          </Button>
        )}
        <Button variant="ghost" onClick={onAgain}>
          <RotateCcw className="mr-1 h-3.5 w-3.5" /> {t("Run setup again")}
        </Button>
      </div>
    </div>
  );
}
