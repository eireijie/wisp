import fs from "node:fs";
import path from "node:path";

/**
 * The folder name an agent works in on this device. It is the agent's handle the first time, then
 * stays that name for good, so renaming the handle doesn't leave its files, checkouts and sessions behind.
 */
export function agentFolder(dir: string, agent: { id: string; handle: string }): string {
  const file = path.join(dir, "agents", ".folders.json");
  let known: Record<string, string> = {};
  try {
    known = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    /* none yet */
  }
  if (known[agent.id]) return known[agent.id];
  // another agent may still be using this name from before it was renamed
  const taken = new Set(Object.values(known));
  const name = taken.has(agent.handle) ? `${agent.handle}-${agent.id.replace(/\W/g, "").slice(0, 6)}` : agent.handle;
  known[agent.id] = name;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(known, null, 2));
  } catch {
    /* the name still works for this run */
  }
  return name;
}
