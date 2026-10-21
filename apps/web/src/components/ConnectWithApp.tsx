import { useState, type ReactNode } from "react";
import { Check, Download, ExternalLink, Loader2 } from "lucide-react";
import { useDesktopInfo } from "../desktop.ts";
import { connectSteps, joinLink } from "../devices.ts";
import { isLocalOnlyHost } from "../onboarding.ts";
import { Button, CopyBlock, DeviceInstall, cx } from "./ui.tsx";

export const DMG = "https://github.com/eireijie/warren/releases/download/desktop-v0.0.1/Warren-0.0.1-arm64.dmg";

/**
 * The no-Terminal way to connect a computer: download the Warren app, open it from here with a
 * link that carries this device's connection code, and watch it connect. Only the last step is
 * something the hub can see; the first two are remembered from the clicks here.
 */
export function ConnectWithApp({ name, token, connected }: { name: string; token: string; connected: boolean }) {
  const { inDesktop, info, connect } = useDesktopInfo();
  const [busy, setBusy] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [opened, setOpened] = useState(false);
  const hub = location.origin;
  const link = joinLink(hub, token, name);

  if (inDesktop)
    return (
      <div className="rounded-xl border border-line bg-panel p-4 space-y-2">
        <p className="text-sm font-medium">This Mac is being connected automatically</p>
        <p className="text-sm text-muted">
          {connected ? `${name} is connected.` : info?.device ? "Connected to Warren. It can take a few seconds to show up here." : "The Warren app has not connected this Mac yet."}
        </p>
        {!connected && !info?.device && (
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await connect();
              } finally {
                setBusy(false);
              }
            }}
          >
            Connect this Mac
          </Button>
        )}
      </div>
    );

  const steps = connectSteps({ downloaded, opened, connected });
  return (
    <div className="rounded-xl border border-line bg-panel p-4 space-y-4">
      <p className="text-sm font-medium">Easiest: the Warren app for Mac</p>
      <ol className="space-y-3" aria-label="Connecting with the app">
        <Step n={1} done={steps.downloaded} title="Download Warren for Mac" current={!steps.downloaded}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <a className="font-medium underline" href={DMG} onClick={() => setDownloaded(true)}>
              <Download size={14} className="inline -mt-0.5 mr-1" />
              Download for this Mac
            </a>
            <a className="text-muted underline" href="https://github.com/eireijie/warren/releases" target="_blank" rel="noreferrer">
              All releases
            </a>
          </div>
          <p className="text-xs text-muted">For a Mac from 2020 on (M1 chip or newer). Open the file and drag Warren to Applications, then open it once.</p>
        </Step>
        <Step n={2} done={steps.opened} title={`Open it as ${name}`} current={steps.downloaded && !steps.opened}>
          <p className="text-xs text-muted">This hands the app everything it needs: the server's address and this device's connection code.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={steps.downloaded && !steps.opened ? "primary" : "default"}
              onClick={() => {
                setOpened(true);
                location.href = link;
              }}
            >
              <ExternalLink size={15} /> Open in the Warren app
            </Button>
            {steps.opened && !connected && (
              <span className="text-xs text-muted">Nothing happened? Then the app isn't installed yet: do step 1, open it once, and press this again.</span>
            )}
          </div>
        </Step>
        <Step n={3} done={connected} title={connected ? `${name} is connected` : `Waiting for ${name} to connect`} current={steps.opened && !connected} live>
          {!connected && <p className="text-xs text-muted">This page updates by itself when the app has connected. Nothing else to do here.</p>}
        </Step>
      </ol>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted">The app is open but didn't get the link</summary>
        <div className="mt-2 space-y-2">
          <p className="text-muted">In the app, choose “Join a server” and paste this link where it asks for the address:</p>
          <CopyBlock text={link} />
          {isLocalOnlyHost(location.hostname) && (
            <p className="text-muted">This link only works on this computer, because the address in it is local. On another computer, use this Mac's network address instead.</p>
          )}
        </div>
      </details>
    </div>
  );
}

function Step({ n, done, current, live, title, children }: { n: number; done: boolean; current: boolean; live?: boolean; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className={cx("mt-0.5 size-6 shrink-0 rounded-full grid place-items-center text-xs font-semibold", done ? "bg-ok text-white" : current ? "bg-accent text-accent-ink" : "bg-chip text-muted")}
        aria-hidden
      >
        {done ? <Check size={13} /> : live && current ? <Loader2 size={13} className="animate-spin" /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className={cx("text-sm", done ? "text-muted line-through decoration-muted/50" : "font-medium")} aria-current={current ? "step" : undefined}>
          {title}
          <span className="sr-only">{done ? ", done" : current ? ", current step" : ""}</span>
        </div>
        {!done && children}
      </div>
    </li>
  );
}

/** The Terminal way, folded away: the command needs the same connection code. */
export function ConnectWithCommand({ name, token }: { name: string; token: string }) {
  return (
    <details className="rounded-xl border border-line p-4">
      <summary className="cursor-pointer text-sm font-medium">Connect another computer with a command</summary>
      <div className="mt-3 space-y-3">
        <DeviceInstall token={token} name={name} />
        <p className="text-xs text-muted">“warren node start” stops when you close its terminal window; “warren service install node” keeps it running in the background.</p>
      </div>
    </details>
  );
}
