import { useState } from "react";
import { Play, Trash2 } from "lucide-react";
import { describeCron, nextRun, type ChannelTeam, type TeamStep } from "@wisp/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { cx } from "../components/ui.tsx";
import { FieldBox, PickBox, TextBox } from "./parts.tsx";
import { numberOf, stepById, updating } from "./flow.ts";
import { Toggle } from "./StepForm.tsx";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
type Repeat = "hourly" | "daily" | "weekly" | "monthly" | "custom";
const REPEATS: { value: Exclude<Repeat, "custom">; label: string }[] = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

/** A cron schedule as the form's choices; anything they can't say stays as typed cron. */
export function readCron(cron: string): { repeat: Repeat; minute: number; hour: number; day: number; date: number } {
  const plain = { minute: 0, hour: 9, day: 1, date: 1 };
  const hourly = /^(\d+) \* \* \* \*$/.exec(cron);
  if (hourly) return { ...plain, repeat: "hourly", minute: Number(hourly[1]) };
  const m = /^(\d+) (\d+) (\*|\d+) \* (\*|\d)$/.exec(cron);
  if (!m || (m[3] !== "*" && m[4] !== "*")) return { ...plain, repeat: "custom" };
  const at = { ...plain, minute: Number(m[1]), hour: Number(m[2]) };
  if (m[3] !== "*") return { ...at, repeat: "monthly", date: Number(m[3]) };
  return m[4] === "*" ? { ...at, repeat: "daily" } : { ...at, repeat: "weekly", day: Number(m[4]) % 7 };
}

/** The cron schedule for the form's choices. */
export function writeCron(c: { repeat: Exclude<Repeat, "custom">; minute: number; hour: number; day: number; date: number }): string {
  if (c.repeat === "hourly") return `${c.minute} * * * *`;
  if (c.repeat === "daily") return `${c.minute} ${c.hour} * * *`;
  if (c.repeat === "weekly") return `${c.minute} ${c.hour} * * ${c.day}`;
  return `${c.minute} ${c.hour} ${c.date} * *`;
}

/** "Next: Mon, Nov 2", or null when it's off or can't be worked out. */
export function nextText(s: Pick<TeamStep, "schedule" | "timezone" | "enabled">): string | null {
  if (s.enabled === false) return "Off";
  try {
    const at = nextRun(s.schedule ?? "", s.timezone || "UTC");
    return at ? `Next: ${at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: s.timezone || "UTC" })}` : null;
  } catch {
    return null;
  }
}

/** The schedule box's headline: "Every Monday at 9:00 AM". */
export function whenText(s: Pick<TeamStep, "schedule">): string {
  try {
    return describeCron(s.schedule ?? "");
  } catch {
    return "Say when it runs";
  }
}



const zones = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
})();

export function ScheduleForm({ team, stepId, onChange, onDelete, channelId }: { team: ChannelTeam; stepId: string; onChange: (t: ChannelTeam) => void; onDelete: () => void; channelId?: string }) {
  const saved = useStore((s) => s.channels.find((c) => c.id === channelId)?.settings.team?.steps?.some((x) => x.id === stepId && x.kind === "schedule"));
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const step = stepById(team, stepId);
  if (!step) return null;
  const set = (patch: Partial<TeamStep>) => onChange(updating(team, stepId, patch));
  const cron = step.schedule ?? "";
  const c = readCron(cron);
  const change = (patch: Partial<Parameters<typeof writeCron>[0]>) => set({ schedule: writeCron({ repeat: c.repeat === "custom" ? "weekly" : c.repeat, minute: c.minute, hour: c.hour, day: c.day, date: c.date, ...patch }) });
  const time = `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
  const starts = (step.nexts ?? []).map((n) => numberOf(team, n)).filter(Boolean).sort((a, b) => a - b);
  const startsText = starts.length ? `Starts step${starts.length > 1 ? "s" : ""} ${starts.length > 1 ? `${starts.slice(0, -1).join(", ")} and ${starts.at(-1)}` : starts[0]} ${whenText(step).replace(/^Every/, "every")}. Each result goes to the next step along the arrows. A message in the chat still starts the team too.` : "Draw an arrow to the steps it starts.";

  const runNow = async () => {
    setRunning(true);
    setNote(null);
    try {
      await api("POST", `/api/channels/${channelId}/schedules/${stepId}/run`);
      setNote("Started. Follow it in the team's chat.");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-3">
      <Toggle label="On" on={step.enabled !== false} onChange={(enabled) => set({ enabled })} />
      <TextBox label="What the team gets asked" value={step.prompt ?? ""} onChange={(prompt) => set({ prompt })} rows={3} maxLength={8000} placeholder="Put together this week's report." />
      <div role="radiogroup" aria-label="Repeats" className="grid grid-cols-4 overflow-hidden rounded-xl border border-line bg-card">
        {REPEATS.map((r, i) => (
          <button key={r.value} type="button" role="radio" aria-checked={c.repeat === r.value} onClick={() => change({ repeat: r.value })} className={cx("h-10 text-[13px]", i > 0 && "border-l border-line", c.repeat === r.value ? "bg-chip font-medium text-ink" : "text-muted hover:bg-hover")}>
            {r.label}
          </button>
        ))}
      </div>
      {c.repeat === "custom" && (
        <FieldBox label="Custom schedule (cron)">
          <input aria-label="Custom schedule (cron)" value={cron} onChange={(e) => set({ schedule: e.target.value })} className="mt-0.5 block w-full bg-transparent font-mono text-body outline-none" />
        </FieldBox>
      )}
      {c.repeat === "weekly" && <PickBox label="Day" shown={DAYS[c.day]} options={DAYS.map((d, i) => ({ value: String(i), label: d }))} onPick={(v) => change({ day: Number(v) })} />}
      {c.repeat === "monthly" && <PickBox label="Day of the month" shown={String(c.date)} options={Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} onPick={(v) => change({ date: Number(v) })} />}
      {c.repeat === "hourly" && <PickBox label="Minute past the hour" shown={String(c.minute)} options={[0, 15, 30, 45].map((m) => ({ value: String(m), label: String(m) }))} onPick={(v) => change({ minute: Number(v) })} />}
      {(c.repeat === "daily" || c.repeat === "weekly" || c.repeat === "monthly") && (
        <FieldBox label="Time">
          <input
            type="time"
            aria-label="Time"
            value={time}
            onChange={(e) => {
              const [hour, minute] = e.target.value.split(":").map(Number);
              if (Number.isInteger(hour) && Number.isInteger(minute)) change({ hour, minute });
            }}
            className="mt-0.5 block w-full bg-transparent text-body outline-none"
          />
        </FieldBox>
      )}
      <PickBox label="Time zone" shown={step.timezone || "UTC"} options={zones.map((z) => ({ value: z, label: z }))} onPick={(timezone) => set({ timezone })} />
      <p className="px-2 text-xs text-faint">{startsText}</p>
      <div className="flex gap-2 pt-2">
        <button type="button" disabled={!saved || running} title={saved ? undefined : "Save the team first"} onClick={runNow} className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-line bg-card text-body hover:bg-hover disabled:opacity-50">
          <Play size={16} aria-hidden /> Run now
        </button>
        <button type="button" onClick={onDelete} className="flex h-12 items-center justify-center gap-2 rounded-xl border border-line bg-card px-4 text-body text-bad hover:bg-hover">
          <Trash2 size={16} aria-hidden /> Delete
        </button>
      </div>
      {note && <p className="px-2 text-xs text-muted">{note}</p>}
    </div>
  );
}
