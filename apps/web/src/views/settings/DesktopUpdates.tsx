import { useEffect, useRef, useState } from "react";
import type { DesktopUpdate } from "../../desktop.ts";
import { Button, Pill } from "../../components/ui.tsx";
import { Card, Row } from "./parts.tsx";

/** What the desktop app says about its own update: a pill and a hint for each state, and the button that fits. */
export function describe(u: DesktopUpdate | null): {
  pill: React.ReactNode;
  hint: string;
} {
  if (!u) return { pill: "Not checked yet", hint: "" };
  switch (u.state) {
    case "checking":
      return { pill: "Checking for updates…", hint: "" };
    case "downloading":
      return {
        pill: <Pill tone="accent">Downloading {u.detail}</Pill>,
        hint: "It installs when you restart Wisp.",
      };
    case "ready":
      return {
        pill: <Pill tone="accent">Wisp {u.version} is ready</Pill>,
        hint: "Restart Wisp to finish updating. It also installs when you quit.",
      };
    case "current":
      return {
        pill: <Pill tone="ok">Up to date</Pill>,
        hint: `You have the newest version, ${u.current}.`,
      };
    case "unsupported":
      return { pill: <Pill>Updates by hand</Pill>, hint: u.detail };
    case "error":
    case "timed-out":
      return { pill: <Pill tone="warn">Couldn't check</Pill>, hint: u.detail };
    default:
      return { pill: "Not checked yet", hint: `This is Wisp ${u.current}.` };
  }
}

/** Updates in the desktop app: checks as the page opens, and downloads and installs right here instead of pointing at a menu. */
export function DesktopUpdates() {
  const updates = window.wispDesktop?.updates;
  const [u, setU] = useState<DesktopUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const check = async () => {
    setError(null);
    try {
      const next = await updates?.check();
      if (live.current && next) setU(next);
    } catch (e) {
      if (live.current) setError((e as Error).message);
    }
  };
  useEffect(() => {
    live.current = true;
    updates?.status().then(
      (s) => live.current && s && setU(s),
      () => {},
    );
    void check();
    return () => {
      live.current = false;
    };
  }, []);
  // while it checks or downloads, follow along
  const busy = u?.state === "checking" || u?.state === "downloading";
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(
      () =>
        updates?.status().then(
          (s) => live.current && s && setU(s),
          () => {},
        ),
      1500,
    );
    return () => clearInterval(t);
  }, [busy]);
  const { pill, hint } = describe(u);
  return (
    <Card>
      <Row label={pill} hint={error ?? hint}>
        {u?.state === "ready" ? (
          <Button variant="primary" onClick={() => void updates?.restart()}>
            Restart to update
          </Button>
        ) : u?.state === "unsupported" ? undefined : (
          <Button onClick={check} disabled={busy}>
            {busy
              ? u?.state === "downloading"
                ? "Downloading…"
                : "Checking…"
              : "Check now"}
          </Button>
        )}
      </Row>
    </Card>
  );
}
