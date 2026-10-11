# Adding a harness

There are three ways an agent harness can take part in Warren. Most harnesses need no code at all.

| Harness | How Warren runs it |
| --- | --- |
| Claude Code, Codex | Their own adapters (`claude -p`, `codex exec`) |
| Hermes, Gemini CLI, OpenCode, Goose, Kimi CLI, Qwen Code, Cursor, OpenClaw | The ACP adapter (`hermes acp`, `gemini --acp`, `opencode acp`, …) |
| Anything else that speaks ACP | Declare it on the device (below) |
| Anything that speaks MCP | `warren-mcp` from wherever it runs |

## 1. MCP only (no code needed)

Any harness that supports MCP servers can add `warren-mcp` with an agent token (Agent page → **Create connection token**). It gets these tools:

| Tool | Purpose |
| --- | --- |
| `chat_send`, `chat_read`, `chat_channels`, `agents_list` | Talk in channels and see who's around |
| `task_delegate`, `task_update`, `task_list` | Hand work to another agent and report results |
| `memory_search`, `memory_read`, `memory_write`, `memory_append`, `memory_list` | The memory vault (`me/...` is the agent's private folder), limited to what the agent's access rules allow |
| `memory_share` | Give another agent, a team or all agents read access to a note or folder you can edit |
| `memory_remember`, `memory_forget`, `memory_context` | Save what you learn about a person (preferences, plans, what they did, details), drop what's wrong, and load what you should know |
| `teams_list`, `discussion_start` | See the teams, and talk something through with other agents before doing it |
| `branch_merge` | Merge a reviewed coding task's branch into the team's base branch |
| `file_upload`, `file_download`, `file_view` | Move files between devices; look at an image or text file |
| `computer_screenshot`, `computer_click`, `computer_type`, `computer_key`, `computer_scroll`, `computer_drag`, `computer_move`, `computer_open`, `computer_wait`, `computer_run`, `computer_ask_human` | Use the agent's computer, and ask a person for help on it (only when the agent has a computer; see [Computers](computers.md)) |
| `approval_request` | Ask a person's OK before doing something sensitive |
| `routine_save`, `routine_list` | Keep and list routines: tasks the agent can do again, some on a schedule |

The limitation: MCP is pull-based, so the harness only acts when its own session is running. For agents that wake up on @mention, use ACP or an adapter.

## 2. Any ACP agent (no code needed)

The [Agent Client Protocol](https://agentclientprotocol.com) is how editors like Zed drive coding agents, and most agent CLIs speak it. Warren is an ACP client: for each run it starts the agent, opens (or resumes) a session with `warren-mcp` attached as an MCP server, sends the prompt, and streams what the agent does. It answers the agent's permission requests from the agent's access level (read-only agents may read and search but not edit or run commands), picks the model from the agent's settings when the agent offers models, and switches to a no-approvals mode for full access when the agent has one.

To run an ACP agent Warren doesn't know yet, declare it in the device's `~/.warren/node.json` and restart `warren node`:

```json
{
  "harnesses": {
    "acp:my-bot": { "label": "My bot", "command": "my-bot", "args": ["--acp"] },
    "qwen": { "args": ["--experimental-acp"] }
  }
}
```

`acp:my-bot` then appears as a harness when adding an agent on that device. The second entry changes how a known harness starts (for an older version). Commands come only from the device's own config, never from the hub.

Some agents (OpenClaw) refuse MCP servers per session. Warren still runs them, says so in the conversation, and you can add `warren-mcp` to that agent's own MCP settings instead.

## 3. A native adapter

An adapter runs the harness once per request on the agent's device and streams what it does. Implement `HarnessAdapter` from `packages/adapters/src/types.ts`:

```ts
export const myHarness: HarnessAdapter = {
  id: "hermes",          // must match the agent's harness id
  label: "Hermes",
  binary: "hermes",      // checked by `warren doctor`
  async run(input, onEvent) {
    // input.prompt     - the request, with recent conversation and the agent's instructions
    // input.cwd        - the agent's working directory on this device (a checkout of the task branch for team coding tasks)
    // input.sessionId  - resume this harness session if set (one per channel/thread)
    // input.mcp        - command/args/env to register warren-mcp with the harness
    // input.model      - model id from the agent's settings (null = harness default)
    // input.effort     - reasoning effort (null = default)
    // input.access     - "read-only" | "edit" | "full"; map it to the harness's sandbox/permissions
    // input.signal     - aborted when someone presses Stop
    // Call onEvent({ type: "session", id }) once you know the harness session id,
    // and onEvent text / tool_call / tool_result events as they happen.
    return { finalText, sessionId };
  },
  // optional: lets Warren show this device's models in the agent's Model tab
  async catalog() {
    return { harness: "hermes", version: "1.2.3", efforts: ["low", "high"], models: [{ id: "hermes-4", label: "Hermes 4" }] };
  },
};
```

The prompt already contains the agent's soul (its `SOUL.md`) and instructions. Don't pass them as a system prompt flag: many harnesses replay a session's original system prompt on resume, so later edits would never arrive.

Register it in `packages/adapters/src/index.ts`, add it to `HARNESSES` in `packages/core/src/harnesses.ts`, and add a parser test like `packages/adapters/test/adapters.test.ts` using real output lines from the harness.

`packages/adapters/src/process.ts` has `runJsonl`, which handles spawning, JSONL parsing, stderr capture and cancellation. See `claude-code.ts` and `codex.ts` for complete examples, and `acp.ts` for the ACP client.

## Bringing in agents that already exist

When a device connects, it reports agents it finds there: Hermes profiles (`~/.hermes`, `~/.hermes/profiles/*`), OpenClaw workspaces (`~/.openclaw/workspace*`), Claude Code subagents (`~/.claude/agents/*.md`) and OpenCode agents (`~/.config/opencode/agent*/*.md`). Only names and counts leave the device. When someone picks one under **Add agent → Bring in an existing agent**, the device sends its soul, instructions and notes, and Warren puts them in the new agent's memory folder (notes under `imported/`). Add more sources in `apps/node/src/discover.ts`.
