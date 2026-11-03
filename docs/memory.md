# Memory

Wisp keeps each workspace's memory in a folder of markdown notes backed by git. Notes support `[[wikilinks]]`, backlinks, tags and search, and edits have a history showing who changed what.

Open the folder in [Obsidian](https://obsidian.md) to browse and write, or use Wisp's **Memory** page to search, create, edit and delete notes. **Activity** shows changes across the vault; each note also has history and line authorship. Access rules apply to Wisp's tools and sync gateway; opening the folder directly on disk gives access through that computer's filesystem permissions.

## Memory permissions

Use the share button on a folder or note in **Memory**, or **Settings → Memory**, to set access and **Load at startup**. Owners can use **View as** to inspect what an agent can see.

| Who | Default access |
| --- | --- |
| Every agent | Read and edit `shared/`, its own `agents/<id>/` and every person's `people/<id>/` folder |
| Agents on a team | Read and edit the team's configured memory folder, if it has one; there is no team folder by default |
| Owners | Manage everything, including access rules |
| Members | Read and edit notes except other people's `people/<id>/` folders; explicit rules can restrict access |
| Each owner or member | Manage their own `people/<id>/` folder |
| Guests | Read `shared/` and their own `people/<id>/` folder; guests cannot edit notes |

A team's folder is the path configured on the team, not an automatically assigned `teams/<name>/` path. If the team reports to an agent, that agent and those above it in the reporting chain also get read and edit access to its configured folder.

- **Rules:** grant one agent, a team role, a team, all agents, one person, members or guests *no access*, *can read*, *can edit* or *can manage*. Only people can manage access; owners always retain it, and guests are limited to reading.
- **Inheritance:** a folder's rule applies to its contents, but a rule closer to a note wins. At the same path, one agent takes precedence over its role, then its team, then all agents; a stored rule takes precedence over a matching default.
- **New folders:** top-level folders such as `Projects/` start with member access and no agent access until shared. The defaults for `shared/`, agents' own folders and people's folders still apply at those paths.
- **Load at startup:** select a note or folder for agents to receive its notes in their prompt, subject to read access and the size limits described below.
- **Agent sharing:** `memory_share` gives another agent, a team or all agents read access to a note or folder the sharing agent can edit. Shares can be removed in Settings, and a matching rule set by a person takes precedence.

An agent can use `me/notes.md` as shorthand for a note in its own `agents/<id>/` folder. This folder is private from other agents by default, but owners and members can access it unless rules restrict members; an agent's locked `SOUL.md` is read-only to that agent.

## Choosing the vault folder

The first workspace's vault defaults to `<data>/vault`. An owner can choose another folder in **Settings → Memory → Use a different folder**, or set `WISP_VAULT_DIR=/path/to/folder` where the hub runs; the environment variable takes precedence and changes take effect after a restart.

Only the first workspace's vault can move this way. Other workspaces keep separate vaults and search indexes under `<data>/orgs/<id>/vault`.

- An existing Obsidian vault can be adopted in place. Wisp runs `git init` if needed, commits existing notes when starting its history, and keeps an existing repository's history.
- `.obsidian/` and `.trash/` are added to `.gitignore` and excluded from indexing and normal vault commits. Wisp leaves those folders alone and does not follow symlinks while scanning.
- Wisp refuses a drive root, your home folder, a folder containing its own data directory, or a path inside its uploaded-files directory. The account running the hub needs write access to the chosen folder.
- When the location changes, Wisp carries the earlier vault over on the next start. An empty destination gets a copy including git history; a nonempty destination gets only missing files, without the earlier vault's hidden tool folders or `.git` history, and existing files are not overwritten. The earlier folder is left in place; Settings shows its location.
- In Docker, the vault path must be inside a mounted volume. For example, add `-v ~/Obsidian/Wisp:/vault -e WISP_VAULT_DIR=/vault` to your container configuration and run it as an account that can write there; see [Deploying](deploy.md#docker).

## Memory in Obsidian

### On the hub's computer

Open the vault folder in Obsidian. **Open in Obsidian** on Wisp's Memory page opens the local path, so use it on the computer running the hub.

Wisp watches for outside edits, commits them as **Edited in Obsidian**, and updates the search index. A scan every 30 seconds backs up the watcher; opening **Settings → Memory** or pressing **Refresh** in Memory also scans. Agent writes are tracked separately so the watcher does not treat them as outside edits.

### Syncing from another computer

The hub serves the vault through git at `/git/vault.git`; git must be installed on the hub for its HTTP backend. In **Settings → Memory**, create a sync token and copy it when it is shown, then clone the vault:

```bash
git clone https://your-hub.example.com/git/vault.git "Wisp memory"
```

Use any username and the sync token as the password when git asks. Open the cloned folder in Obsidian, install the community **Git** plugin (Vinzent03/obsidian-git), and configure it to pull and push on a schedule. Use HTTPS or a private network such as Tailscale when connecting beyond your own network; the token authenticates every request.

A sync token is separate from a normal sign-in token. The hub stores only its hash, shows the token once, and lets you revoke it in Settings.

### Who can sync and what a push may change

A clone contains the entire history, and git cannot hide individual folders. Owners can sync; members can sync only while their current access rules allow them to read every note path that has ever existed, including deleted notes; guests cannot sync. The hub checks this on every request, so restricting access can also stop an existing clone from pulling or pushing.

Reads use a separate bare repository that borrows the vault's git objects. Pushes go to a temporary repository first and are accepted only after validation:

- Only fast-forward updates to the vault's own branch are allowed; branch deletion and other branches are refused, and git checks the received objects.
- Every changed path is checked against the person's edit access. Hidden paths such as `.obsidian`, symlinks and submodules are refused.
- Accepted commits enter the vault while it is locked against other writes. A rejected push leaves the vault unchanged by that push and returns a reason.
- Git commits retain the author configured on the person's computer, while Wisp's Activity, history and line authorship attribute accepted pushes to that person's Wisp name.

Wisp commits outside edits on the hub before evaluating a push. If someone edited in Obsidian there at the same time, pull those changes before pushing again.

## What agents know when they start

Wisp assembles context for each run alongside the conversation and request:

1. **Soul and instructions:** the agent's personality and the instructions people gave it.
2. **About the person:** saved preferences, active plans, up to 25 recent activity entries from the last week, and details ranked by relevance to the request, within a size budget. The person is the sender, the last person in the conversation, or the workspace owner as a fallback, and the agent must have access to that person's memory.
3. **Teams:** the chart and roles, with role notes, teammates, reporting relationships, repository details and, when configured, an excerpt from the team folder's `README.md` and recent decisions.
4. **Startup notes:** readable notes selected with **Load at startup**, limited to 4,000 characters per note and a shared 16,000-character budget. The prompt lists remaining note paths so the agent can read them when needed.
5. **Related notes:** up to five search matches with snippets, excluding notes already shown, which the agent can open with `memory_read`.

Agents save information about people with `memory_remember`, and people can inspect, correct or delete it on **About you**. Claude Code's automatic device-local memory is disabled for Wisp runs so this information can be kept in the shared vault.

Sessions connected through `wisp-mcp` receive memory context at initialization and can request fresh context with `memory_context`. Skills assigned to an agent are stored in its private folder and listed in its prompt; see [Connectors and skills](adapters.md#connectors-and-skills).

## How agents keep memory up to date

Agents save as they work: their built-in memory skill tells them to search first, update the note that's already there, and link related notes with `[[wikilinks]]`. The hub also enforces this on every save an agent makes, without any model calls:

- A save that holds a password, key, token or card number is refused. Agents write where the secret lives instead.
- A new note that repeats an existing one (nearly the same words, or the same title and much of the same text) is refused, and the agent is told which note to update.
- A note that links to nothing gets a `Related:` line linking the notes it mentions or is closest to, so the graph doesn't grow islands.

Models don't always save when a prompt asks them to, so the hub also looks at how each chat run ended. If the run did real work (several tool calls), finished a task, ended a discussion with a decision, or the person said something lasting ("I prefer…", "we decided…", "from now on…"), and the agent saved nothing, the hub queues a short **memory pass**. Once the chat has been quiet for 3 minutes (or at most 20 minutes after the first item), the agent gets one fresh run in its own conversation with what happened, and saves or updates linked notes. Nothing is posted in the chat. When the agent does the same kind of task again (similar request, same tools, within 30 days) or the person shows it how to do something, the pass also asks it to save the steps as a skill (`skill_save`), unless it already has a skill for that or skill learning is off.

Memory passes cost model tokens, so they are kept small:

- They count against the person's daily background allowance and use the model and effort picked for background checks (low effort by default). Past 80% of the allowance they stop until the next day.
- At most 8 passes per agent and person a day, one at a time per agent, and runs close together share one pass.
- No pass when the agent already saved during the run, or when the run was a quick answer.

Once a day the hub tidies recent notes in `shared/` and agents' folders (no model): notes nothing links to and that link nothing get a `Related:` line, and notes in an agent's folder that look like the same idea are handed to that agent's next pass to merge.

Every save is a git commit credited to the agent; saves from a memory pass say "memory pass after work in …" in their message. Open a note's History to see who changed it and **Restore** an earlier version, or delete a note that shouldn't have been saved. An owner can turn memory passes off with `PUT /api/settings/agents` and `{"autoMemory": false}`; the save guards above always apply.
