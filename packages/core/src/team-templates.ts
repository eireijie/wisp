/**
 * Starting points for a team. Each role says what it owns and which harness usually suits it. The
 * harness is only a suggestion: people can rename or drop roles, add their own, and put any agent
 * (or a new one on any harness) in each.
 */
export interface TeamRoleTemplate {
  /** the job title, e.g. "Backend" */
  role: string;
  /** what it owns and what to send its way; becomes the member's roleNotes, which agents read in their prompt */
  notes: string;
  /** a harness that tends to suit the role; never required */
  harness: string;
  /** the one who takes the team's work and hands it out */
  lead?: boolean;
}

export interface TeamTemplate {
  id: string;
  name: string;
  emoji: string;
  description: string;
  roles: TeamRoleTemplate[];
}

export const TEAM_TEMPLATES: TeamTemplate[] = [
  {
    id: "build",
    name: "Build team",
    emoji: "🛠️",
    description: "Builds and ships software. One agent leads and builds, others take the backend and the look of it, and a different one checks the work before it lands.",
    roles: [
      { role: "Lead & builder", notes: "Takes new work, splits it into pieces and hands each to whoever owns it. Builds whatever doesn't fit anyone else and keeps the team's brief up to date.", harness: "hermes", lead: true },
      { role: "Backend", notes: "Owns the server side: APIs, data, tests and anything that runs behind the scenes. Send it work that touches storage, logic or integrations.", harness: "codex" },
      { role: "Frontend & design", notes: "Owns what people see and touch: screens, layout, copy and polish. Send it work on the interface and how it feels to use.", harness: "kimi" },
      { role: "Reviewer", notes: "Reads finished work before it merges: checks it does what was asked, runs the tests and looks for bugs. Doesn't review its own work; sends fixes back to whoever built it.", harness: "claude-code" },
    ],
  },
  {
    id: "research",
    name: "Research team",
    emoji: "🔎",
    description: "Finds things out and writes them up. One agent leads the question, others dig in and check the facts.",
    roles: [
      { role: "Lead researcher", notes: "Takes the question, breaks it into things to look up and hands them out. Pulls the answers together into one clear write-up.", harness: "claude-code", lead: true },
      { role: "Researcher", notes: "Digs into sources, reads closely and reports what it found, with where each fact came from.", harness: "gemini" },
      { role: "Analyst", notes: "Works with numbers and data: collects it, cleans it up and says what it shows.", harness: "codex" },
      { role: "Fact-checker", notes: "Checks claims and sources in the write-up before it goes out, and says what doesn't hold up.", harness: "hermes" },
    ],
  },
  {
    id: "solo-reviewer",
    name: "Solo + reviewer",
    emoji: "🧑‍💻",
    description: "One agent does the work and a second, on a different harness, looks over everything before it counts as done.",
    roles: [
      { role: "Builder", notes: "Takes the work and does it start to finish.", harness: "hermes", lead: true },
      { role: "Reviewer", notes: "Looks over the builder's finished work, tests it and says what to fix. Doesn't review its own work.", harness: "claude-code" },
    ],
  },
];
