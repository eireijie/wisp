# Adding a harness

There are three ways an agent harness can take part in Wisp. Most harnesses need no code at all.

| Harness | How Wisp runs it |
| --- | --- |
| Claude Code, Codex | Their own adapters (`claude -p`, `codex exec`) |
| Hermes, Gemini CLI, OpenCode, Goose, Kimi CLI, Qwen Code, Cursor, OpenClaw | The ACP adapter (`hermes acp`, `gemini --acp`, `opencode acp`, …). Hermes and Kimi CLI also come with the VM image and run inside the agent's VM, like Claude Code and Codex (see [Computers](computers.md)) |
| Anything else that speaks ACP | Declare it on the device (below) |
| Anything that speaks MCP | `wisp-mcp` from wherever it runs |

## 1. MCP only (no code needed)

Any harness that supports MCP servers can add `wisp-mcp` with an agent token (Agent page → **Create connection token**). It gets these tools:

| Tool | Purpose |
| --- | --- |
| `chat_send`, `chat_read`, `chat_channels`, `agents_list` | Talk in teams and see who's around |
| `task_delegate`, `task_update`, `task_list` | Hand work to another agent and report results |
| `memory_search`, `memory_read`, `memory_write`, `memory_append`, `memory_list` | The memory vault (`me/...` is the agent's private folder), limited to what the agent's access rules allow |
| `memory_share` | Give another agent, a team or all agents read access to a note or folder you can edit |
| `memory_remember`, `memory_forget`, `memory_context` | Save what you learn about a person (preferences, plans, what they did, details), drop what's wrong, and load what you should know |
| `teams_list`, `discussion_start` | See the teams, and talk something through with other agents before doing it |
| `team_setup` | Set up a team's roles and steps from what a person described |
| `branch_merge` | Merge a reviewed coding task's branch into the team's base branch |
| `file_upload`, `file_download`, `file_view` | Move files between devices; look at an image or text file |
| `computer_screenshot`, `computer_click`, `computer_type`, `computer_key`, `computer_scroll`, `computer_drag`, `computer_move`, `computer_open`, `computer_wait`, `computer_run`, `computer_ask_human` | Use the agent's computer, and ask a person for help on it (only when the agent has a computer; see [Computers](computers.md)) |
| `approval_request` | Ask a person's OK before doing something sensitive |
| `routine_save`, `routine_list` | Keep and list routines: tasks the agent can do again, some on a schedule |

The limitation: MCP is pull-based, so the harness only acts when its own session is running. For agents that wake up on @mention, use ACP or an adapter.

## 2. Any ACP agent (no code needed)

The [Agent Client Protocol](https://agentclientprotocol.com) is how editors like Zed drive coding agents, and most agent CLIs speak it. Wisp is an ACP client: for each run it starts the agent, opens (or resumes) a session with `wisp-mcp` attached as an MCP server, sends the prompt, and streams what the agent does. It answers the agent's permission requests from the agent's access level (read-only agents may read and search but not edit or run commands), picks the model from the agent's settings when the agent offers models, and switches to a no-approvals mode for full access when the agent has one.

To run an ACP agent Wisp doesn't know yet, declare it in the device's `~/.wisp/node.json` and restart `wisp node`:

```json
{
  "harnesses": {
    "acp:my-bot": { "label": "My bot", "command": "my-bot", "args": ["--acp"] },
    "qwen": { "args": ["--experimental-acp"] }
  }
}
```

`acp:my-bot` then appears as a harness when adding an agent on that device.

Inside a VM, the ACP adapter starts the copy of the agent that comes with the VM image (`hermes acp`, `kimi acp`) through the run's `launch` option, so a device's own `command` or `args` for a known harness only apply to runs on the device. To put another harness in the VM, install it in `docker/computer/Dockerfile`, add its id to `VM_HARNESSES` in `packages/core/src/harnesses.ts`, and give it a sign-in command and a signed-in check in `apps/node/src/computers/docker.ts`. The second entry changes how a known harness starts (for an older version). Commands come only from the device's own config, never from the hub.

Some agents (OpenClaw) refuse MCP servers per session. Wisp still runs them, says so in the conversation, and you can add `wisp-mcp` to that agent's own MCP settings instead.

## 3. A native adapter

An adapter runs the harness once per request on the agent's device and streams what it does. Implement `HarnessAdapter` from `packages/adapters/src/types.ts`:

```ts
export const myHarness: HarnessAdapter = {
  id: "hermes",          // must match the agent's harness id
  label: "Hermes",
  binary: "hermes",      // checked by `wisp doctor`
  async run(input, onEvent) {
    // input.prompt     - the request, with recent conversation and the agent's instructions
    // input.cwd        - the agent's working directory on this device (a checkout of the task branch for team coding tasks)
    // input.sessionId  - resume this harness session if set (one per team/thread)
    // input.mcp        - command/args/env to register wisp-mcp with the harness
    // input.model      - model id from the agent's settings (null = harness default)
    // input.effort     - reasoning effort (null = default)
    // input.access     - "read-only" | "edit" | "full"; map it to the harness's sandbox/permissions
    // input.signal     - aborted when someone presses Stop
    // input.connectors - more MCP servers the agent's owner connected (Connectors page); register them like input.mcp
    // input.env        - environment for the harness, including API keys from "key" connectors
    // Call onEvent({ type: "session", id }) once you know the harness session id,
    // and onEvent text / tool_call / tool_result events as they happen.
    return { finalText, sessionId };
  },
  // optional: lets Wisp show this device's models in the agent's Model tab
  async catalog() {
    return { harness: "hermes", version: "1.2.3", efforts: ["low", "high"], models: [{ id: "hermes-4", label: "Hermes 4" }] };
  },
};
```

The prompt already contains the agent's soul (its `SOUL.md`) and instructions. Don't pass them as a system prompt flag: many harnesses replay a session's original system prompt on resume, so later edits would never arrive.

Register it in `packages/adapters/src/index.ts`, add it to `HARNESSES` in `packages/core/src/harnesses.ts`, and add a parser test like `packages/adapters/test/adapters.test.ts` using real output lines from the harness.

`packages/adapters/src/process.ts` has `runJsonl`, which handles spawning, JSONL parsing, stderr capture and cancellation. See `claude-code.ts` and `codex.ts` for complete examples, and `acp.ts` for the ACP client.

## Connectors and skills

People add **connectors** on the Connectors page (MCP servers, local or remote, and API keys) and pick which agents get each. The hub sends an agent's enabled ones with every run (`RunRequest.connectors`), with `{{NAME}}` templates filled and secrets in the clear; the device passes MCP ones to the adapter as `input.connectors` and puts keys in `input.env`. Today:

| | local MCP (stdio) | remote MCP (http/sse) | keys (env) |
|---|---|---|---|
| Claude Code | `--mcp-config` | `--mcp-config` | yes |
| Codex | `-c mcp_servers.<name>.command/args/env` | `-c mcp_servers.<name>.url/http_headers` | yes |
| ACP agents | `session/new` `mcpServers` | not yet (optional in ACP) | yes |
| MCP-only (Grok, custom) | not wired: they run outside Wisp | | |

**Skills** from the Skills page are written into each agent's private folder as `agents/<id>/skills/<slug>/SKILL.md` and listed in its prompt (name, when to use it, path), so any harness that can read its memory follows them. Nothing adapter-specific is needed.

## Bringing in agents that already exist

When a device connects, it reports agents it finds there: Hermes profiles (`~/.hermes`, `~/.hermes/profiles/*`), OpenClaw workspaces (`~/.openclaw/workspace*`), Claude Code subagents (`~/.claude/agents/*.md`) and OpenCode agents (`~/.config/opencode/agent*/*.md`). Only names and counts leave the device. When someone picks one under **Add agent → Bring in an existing agent**, the device sends its soul, instructions and notes, and Wisp puts them in the new agent's memory folder (notes under `imported/`). Hermes profiles are text only (soul and notes), so they move into a VM like any other agent; its provider keys stay behind, and the agent is signed in on the VM once. Add more sources in `apps/node/src/discover.ts`.
