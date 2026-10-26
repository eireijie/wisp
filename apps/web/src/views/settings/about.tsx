import { GITHUB_URL } from "@wisp/core";
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { api } from "../../api.ts";
import { useStore } from "../../store.ts";
import { href } from "../../router.ts";
import { Button, Modal, Pill } from "../../components/ui.tsx";
import { Card, PageHeader, Row, Section } from "./parts.tsx";

interface UpdateInfo {
  version: { commit: string | null; date: string | null };
  check: { behind: number | null; changes: string[]; canUpdate: boolean; reason: string } | null;
  update: { state: "idle" | "updating" | "restarting" | "failed"; message: string; log: string[] };
}

/** A commit line ("8f380af Settings pages share one look") without its hash. */
const subject = (line: string) => line.slice(line.indexOf(" ") + 1);

/** About: the hub's version, what's new, and the update flow: available, confirm, updating, failed. The page reloads once the hub is back. */
export function AboutPage() {
  const isOwner = useStore((s) => s.me)?.role === "owner";
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [news, setNews] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      setInfo(await api<UpdateInfo>("POST", "/api/updates/check"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    api<UpdateInfo>("GET", "/api/updates").then(setInfo, () => {});
    check();
  }, []);

  // while the hub updates, follow along; it goes away while restarting, then comes back on the new version
  const busy = !!restarting || info?.update.state === "updating" || info?.update.state === "restarting";
  useEffect(() => {
    if (!busy) return;
    const from = restarting ?? info?.version.commit ?? null;
    const t = setInterval(async () => {
      const next = await api<UpdateInfo>("GET", "/api/updates").catch(() => null);
      if (!next) return setRestarting(from ?? "");
      if (next.update.state === "restarting") setRestarting(from ?? "");
      if (restarting !== null && next.version.commit !== restarting) return location.reload();
      setInfo(next);
    }, 2000);
    return () => clearInterval(t);
  }, [busy, restarting]);

  const update = async () => {
    setError(null);
    setConfirm(false);
    try {
      const r = await api<{ update: UpdateInfo["update"] }>("POST", "/api/updates/hub");
      setInfo((i) => i && { ...i, update: r.update });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const v = info?.version;
  const c = info?.check;
  const u = info?.update;

  if (busy)
    return (
      <div className="min-h-[60vh] grid place-items-center text-center">
        <div className="max-w-sm space-y-3">
          <h2 className="text-[28px] font-bold tracking-tight">Updating Wisp</h2>
          <p className="text-[15px] text-muted">Everyone is briefly disconnected. This page reloads by itself when the hub is back.</p>
          <p className="text-sm text-faint" role="status">
            {restarting !== null || u?.state === "restarting" ? "Restarting the hub…" : (u?.log.at(-1) ?? "Updating…")}
          </p>
        </div>
      </div>
    );
  if (u?.state === "failed")
    return (
      <div className="min-h-[60vh] grid place-items-center text-center">
        <div className="max-w-sm space-y-4">
          <h2 className="text-[28px] font-bold tracking-tight">The update didn't finish</h2>
          <p className="text-[15px] text-muted">Wisp is still running the version it had. Nothing was lost. You can try again, or ask the person who runs the hub.</p>
          <p className="text-sm text-bad whitespace-pre-wrap">{u.message}</p>
          <div className="flex justify-center gap-2">
            {isOwner && (
              <Button variant="primary" onClick={update}>
                Try again
              </Button>
            )}
            <Button onClick={check}>Back to About</Button>
          </div>
        </div>
      </div>
    );
  if (news)
    return (
      <>
        <PageHeader title="What's new">{v?.commit ? `This hub runs Wisp ${v.commit}.` : "What changed in Wisp."}</PageHeader>
        <Card>{c?.changes.length ? c.changes.map((line) => <Row key={line} label={subject(line)} />) : <Row label="Nothing new right now" hint="You have everything Wisp has published." />}</Card>
        <Button className="mt-6" onClick={() => setNews(false)}>
          Back to About
        </Button>
      </>
    );
  return (
    <>
      <PageHeader title="About">
        Wisp{v?.commit ? ` ${v.commit}` : ""}
        {v?.date && <> from {new Date(v.date).toLocaleDateString()}</>}. Free and open source. Your data stays on this hub.
      </PageHeader>
      <Section title="Updates">
        <Card>
          <Row
            label={
              !c ? (
                checking ? "Asking GitHub what's new…" : "Not checked yet"
              ) : c.canUpdate ? (
                <Pill tone="accent">Update available</Pill>
              ) : c.behind === 0 ? (
                <Pill tone="ok">Up to date</Pill>
              ) : (
                <Pill tone="warn">Can't update here</Pill>
              )
            }
            hint={c?.reason}
          >
            <Button onClick={check} disabled={checking}>
              {checking ? "Checking…" : "Check now"}
            </Button>
          </Row>
          {c?.canUpdate && c.changes.length > 0 && (
            <div className="px-[18px] py-3 space-y-1.5">
              <div className="text-[13px] font-semibold text-faint">What's changed</div>
              <ul className="space-y-1 text-sm">
                {c.changes.slice(0, 8).map((line) => (
                  <li key={line} className="truncate">
                    {subject(line)}
                  </li>
                ))}
                {c.changes.length > 8 && <li className="text-faint">…and {c.changes.length - 8} more</li>}
              </ul>
            </div>
          )}
          {c?.canUpdate && isOwner && (
            <div className="px-[18px] py-3 flex items-center gap-3">
              <Button variant="primary" onClick={() => setConfirm(true)}>
                Update hub
              </Button>
              <span className="text-[13px] text-faint">Everyone will briefly disconnect while the hub restarts.</span>
            </div>
          )}
        </Card>
        {u?.state === "idle" && u.message && <p className="mt-2 px-1 text-sm text-muted">{u.message}</p>}
        {error && <p className="mt-2 px-1 text-sm text-bad">{error}</p>}
      </Section>
      <Section title="About">
        <Card>
          <button className="w-full text-left hover:bg-hover" onClick={() => setNews(true)}>
            <Row label="What's new">
              <ChevronRight size={16} className="text-faint" />
            </Row>
          </button>
          <Row label="Source code" hint="Issues, ideas and contributions welcome.">
            <a className="text-sm text-accent-text hover:underline" href={GITHUB_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </Row>
          <Row label="License" hint="Use it, change it, share it.">
            <span className="text-sm text-muted">Apache-2.0</span>
          </Row>
        </Card>
        <p className="mt-2 px-1 text-[13px] text-faint">
          {isOwner ? "" : "Only owners can update the hub. "}Other devices update from{" "}
          <a className="text-accent-text hover:underline" href={href({ view: "computers", computerId: null })}>
            Computers and devices
          </a>
          .
        </p>
      </Section>
      {confirm && (
        <Modal title="Update and restart the hub?" onClose={() => setConfirm(false)}>
          <p className="text-[15px] text-muted mb-5">Everyone will briefly disconnect. Wisp comes back by itself.</p>
          <div className="flex flex-col gap-2">
            <Button variant="primary" className="h-12" onClick={update}>
              Update and restart
            </Button>
            <Button variant="ghost" className="h-12" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
