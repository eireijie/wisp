import type { Agent, Allowance, Approval, Channel, ComputerAction, ConnectionModel, HarnessSettings, HarnessSettingsChange, Message, ModelConnection, ModelLogin, ModelProvider, Routine, Followup, ChatLoop, Skill } from "@wisp/core";

export interface WispClientOptions {
  url: string; // hub base URL, e.g. http://localhost:4747
  token: string; // agent token, or node token + agentId
  agentId?: string;
  /** the request the agent is working on, so the hub knows which chat its calls are about */
  runId?: string;
  /** used instead of the global fetch, e.g. by the hub calling its own API in-process */
  fetch?: typeof fetch;
}

export class WispError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Minimal typed client for the Wisp hub API. Used by wisp-mcp, the node daemon, and custom agents. */
export class WispClient {
  readonly url: string;
  constructor(private opts: WispClientOptions) {
    this.url = opts.url.replace(/\/+$/, "");
  }

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await (this.opts.fetch ?? fetch)(this.url + path, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        ...(this.opts.agentId ? { "x-wisp-agent": this.opts.agentId } : {}),
        ...(this.opts.runId ? { "x-wisp-run": this.opts.runId } : {}),
        ...(body !== undefined && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : body instanceof Uint8Array ? (body as unknown as BodyInit) : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) throw new WispError((data as { error?: string })?.error ?? `${res.status} ${res.statusText}`, res.status);
    return data as T;
  }

  me() {
    return this.request<{ kind: "user" | "agent"; agent?: Agent; workspace: { id: string; name: string } }>("GET", "/api/me");
  }
  agents() {
    return this.request<Agent[]>("GET", "/api/agents");
  }
  channels() {
    return this.request<Channel[]>("GET", "/api/channels");
  }
  async channelByName(name: string) {
    const n = name.replace(/^#/, "");
    const all = await this.channels();
    return all.find((c) => c.name === n || c.id === n);
  }
  messages(channelId: string, opts: { thread?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.thread) q.set("thread", opts.thread);
    if (opts.limit) q.set("limit", String(opts.limit));
    return this.request<{ messages: Message[] }>("GET", `/api/channels/${channelId}/messages?${q}`);
  }
  send(channelId: string, body: string, opts: { threadId?: string; replyToId?: string; fileIds?: string[] } = {}) {
    return this.request<Message>("POST", `/api/channels/${channelId}/messages`, { body, threadId: opts.threadId, replyToId: opts.replyToId, fileIds: opts.fileIds ?? [] });
  }
  react(messageId: string, emoji: string, on?: boolean) {
    return this.request("POST", `/api/messages/${messageId}/reactions`, { emoji, on });
  }
  /** Make an agent (a lead) or a sub-agent (an agent a lead made), when the organization allows it. */
  spawnAgent(a: { name: string; role?: string; instructions?: string; handle?: string }) {
    return this.request("POST", "/api/agents/spawn", a);
  }
  delegate(to: string, title: string, brief: string, opts: { channelId?: string; fileIds?: string[]; parentTaskId?: string } = {}) {
    return this.request("POST", "/api/tasks", { to, title, brief, ...opts });
  }
  updateTask(id: string, status: "open" | "in_progress" | "done" | "failed", result?: string, verdict?: "approved" | "changes") {
    return this.request("PATCH", `/api/tasks/${id}`, { status, result, ...(verdict ? { verdict } : {}) });
  }
  tasks(filter: { agent?: string; status?: string } = {}) {
    return this.request("GET", `/api/tasks?${new URLSearchParams(filter as Record<string, string>)}`);
  }
  notes() {
    return this.request<{ path: string; title: string; tags: string[]; links: string[] }[]>("GET", "/api/vault/notes");
  }
  readNote(path: string) {
    return this.request<{ path: string; content: string; backlinks: string[] }>("GET", `/api/vault/note?path=${encodeURIComponent(path)}`);
  }
  writeNote(path: string, content: string, message?: string) {
    return this.request<SavedNote>("PUT", "/api/vault/note", { path, content, message });
  }
  appendNote(path: string, text: string) {
    return this.request<SavedNote>("POST", "/api/vault/append", { path, text });
  }
  search(q: string, limit = 10) {
    return this.request<{ path: string; title: string; snippet: string }[]>("GET", `/api/vault/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  }
  deleteNote(path: string) {
    return this.request("DELETE", `/api/vault/note?path=${encodeURIComponent(path)}`);
  }
  /** Save something about a person (default: who you're working with). */
  remember(m: { kind: "preference" | "plan" | "did" | "detail"; text?: string; about?: string; title?: string; status?: "active" | "done" | "dropped"; due?: string | null; pinned?: boolean; replaces?: string; force?: boolean }) {
    return this.request<{ saved: boolean; path?: string; similar?: { path: string; text: string }[]; person: { id: string; name: string } }>("POST", "/api/memory/remember", m);
  }
  /** What this agent would start a run with: who it works with, its teams, pinned and related notes. */
  memoryContext(q = "", about?: string) {
    return this.request<{ text: string }>("GET", `/api/memory/context?${new URLSearchParams({ q, ...(about ? { about } : {}) })}`);
  }
  /** Start a discussion between agents; it runs on its own and ends with a decision note. */
  startDiscussion(d: { topic: string; goal?: string; participants?: string[]; moderator?: string; rounds?: number; team?: string; channelId?: string }) {
    return this.request<{ id: string; threadId: string; channelId: string; rounds: number }>("POST", "/api/discussions", d);
  }
  /** Merge a task's branch into its team's base branch. */
  mergeTask(taskId: string) {
    return this.request<{ ok: boolean; output: string }>("POST", `/api/tasks/${taskId}/merge`);
  }
  /** Every channel's team: `name` is the channel's, `folder` "" when it has no memory folder. */
  /** Set up a channel's roles and steps by role names and agent handles. */
  setTeamSteps(channel: string, team: { schedules?: { cron: string; ask: string; timezone?: string }[]; roles: { name: string; description: string; agent: string }[]; steps: { role?: string; kind?: "do" | "review" | "hand_out" | "ask"; action: string; prompt?: string; inputs?: number[]; send_back_to?: number; max_rounds?: number; hand_to?: string[]; review_by?: string }[] }) {
    return this.request("PUT", `/api/channels/${encodeURIComponent(channel.replace(/^#/, ""))}/team-steps`, team);
  }
  teams() {
    return this.request<{ id: string; channelId: string; name: string; leads: string[]; leadId: string | null; reportsTo: string | null; folder: string; repo: string | null; members: { agentId: string; role: string }[] }[]>("GET", "/api/teams");
  }
  /** Give an agent ("@nova"), a team, or "all agents" read access to a note or folder you can edit. */
  shareNote(path: string, withWho: string) {
    return this.request<{ id: string; path: string }>("POST", "/api/access/share", { path, with: withWho });
  }
  /** The computer this agent uses, or null when it's headless. */
  async myComputer(): Promise<{ id: string; name: string; kind: string; online: boolean; status: string; statusText: string } | null> {
    try {
      return await this.request("GET", "/api/computers/mine");
    } catch (err) {
      if (err instanceof WispError && err.status === 404) return null;
      throw err;
    }
  }
  /** Do something on this agent's computer (screenshots come back as base64 JPEG). */
  computer<T = any>(action: ComputerAction) {
    return this.request<T>("POST", "/api/computers/mine/act", { action });
  }
  /** Sign in to a website on this agent's own computer with a login from the person's password manager; may ask them first. */
  fillLogin(site: string, account?: string) {
    return this.request<{ status: "filled" | "not_filled" | "asked"; message: string; approvalId?: string }>("POST", "/api/logins/fill", { site, ...(account ? { account } : {}) });
  }
  /** Ask a person to do something on this agent's computer (sign in, enter a code). */
  computerHelp(request: string) {
    return this.request<{ ok: boolean; messageId: string }>("POST", "/api/computers/mine/help", { request });
  }
  /** This agent's harness settings on its device (or another harness's there): model, provider, apps, plugins, skills. */
  harnessSettings(harness?: string) {
    return this.request<HarnessSettings & { device: string; models: string[] }>("GET", `/api/agent/harness-settings${harness ? `?harness=${encodeURIComponent(harness)}` : ""}`);
  }
  /** Change them; only works while doing something the device's owner asked for. */
  changeHarnessSettings(changes: HarnessSettingsChange[], harness?: string, useAccount?: string) {
    return this.request<HarnessSettings & { device: string; changed: string[] }>("PATCH", "/api/agent/harness-settings", { changes, ...(harness ? { harness } : {}), ...(useAccount ? { useAccount } : {}) });
  }
  // --- model connections (a person's token; see apps/hub/src/api-models.ts) ---

  /** The caller's model connections: sign-ins and API keys, never their secrets. */
  modelConnections() {
    return this.request<{ connections: ModelConnection[] }>("GET", "/api/model-connections").then((r) => r.connections);
  }
  /** Connect an API key (the hub checks it with the provider first). */
  connectModelKey(provider: ModelProvider, key: string, label?: string) {
    return this.request<ModelConnection>("POST", "/api/model-connections", { provider, kind: "key", key, ...(label ? { label } : {}) });
  }
  /** Start signing in to a provider on one of the caller's devices; poll modelLogin for the link and code. */
  startModelLogin(provider: ModelProvider, opts: { nodeId?: string; harness?: "claude-code" | "codex" | "hermes"; label?: string } = {}) {
    return this.request<ModelLogin & { nodeId: string }>("POST", "/api/model-connections/login", { provider, ...opts });
  }
  modelLogin(loginId: string) {
    return this.request<ModelLogin>("GET", `/api/model-connections/login/${loginId}`);
  }
  /** Type the code a sign-in page showed (Claude's) into the sign-in. */
  modelLoginInput(loginId: string, text: string) {
    return this.request<ModelLogin>("POST", `/api/model-connections/login/${loginId}/input`, { text });
  }
  /** What a connection offers, as `harness` runs it. */
  connectionModels(connectionId: string, harness?: string) {
    return this.request<{ connectionId: string; provider: ModelProvider; harness: string; models: ConnectionModel[]; efforts: string[] }>("GET", `/api/model-connections/${connectionId}/models${harness ? `?harness=${encodeURIComponent(harness)}` : ""}`);
  }

  /** Ask a person's OK before doing something; the answer arrives as a message that wakes the agent. */
  requestApproval(summary: string, details = "") {
    return this.request<Approval>("POST", "/api/approvals", { summary, details });
  }
  /** Write to the person this agent works for, in their DM; it reaches their phone by push. */
  messagePerson(text: string, fileIds: string[] = [], replies: string[] = []) {
    return this.request<{ messageId: string; channelId: string }>("POST", "/api/message-person", { text, fileIds, replies });
  }
  /** This agent's background settings for the person it works for, the organization's mods, and today's allowance. */
  mySettings() {
    return this.request<{
      background: { enabled: boolean; everyMinutes: number; quietStart: string; quietEnd: string; focus: string } | null;
      mods: { key: string; name: string; description: string; on: boolean }[];
      canChangeMods: boolean;
      allowance: Allowance;
    }>("GET", "/api/agent/settings");
  }
  /** Change background settings or mods for the person this agent works for; they see what changed and can undo it. */
  changeSettings(patch: { background?: Partial<{ enabled: boolean; everyMinutes: number; quietStart: string; quietEnd: string; focus: string }>; mods?: Record<string, boolean> }) {
    return this.request<{ changed: string[]; changeId?: string; note?: string }>("POST", "/api/agent/settings", patch);
  }
  /** When this agent's next background check should be. */
  nextCheck(minutes: number, reason = "") {
    return this.request<{ nextAt: string; minutes: number; on: boolean }>("POST", "/api/background/next", { minutes, reason });
  }
  followups() {
    return this.request<Followup[]>("GET", "/api/followups");
  }
  setFollowup(f: { at?: string; inMinutes?: number; note: string; label?: string; waitingOn?: "agent" | "person"; condition?: string }) {
    return this.request<Followup & { timezone: string }>("POST", "/api/followups", f);
  }
  /** `done`: it happened, rather than no longer being needed. */
  cancelFollowup(followupId: string, done = false) {
    return this.request<{ ok: boolean }>("DELETE", `/api/followups/${followupId}${done ? "?done=1" : ""}`);
  }
  /** Where this agent's DM stands: waiting on the person, done (with a wrap-up), open, or dropped. */
  chatStatus(s: { status: ChatLoop["status"]; summary?: string; did?: string; saved?: string; next?: string; checkBackInMinutes?: number }) {
    return this.request<ChatLoop>("POST", "/api/chat-status", s);
  }
  setupStep(s: { step?: string; summary?: string; role?: string; accounts?: string[]; done?: boolean }) {
    return this.request<{ done: boolean; left: string[] }>("POST", "/api/setup-step", s);
  }
  routines() {
    return this.request<Routine[]>("GET", "/api/routines");
  }
  saveRoutine(r: { routineId?: string; name?: string; steps: string; schedule?: string | null; timezone?: string }) {
    return this.request<Routine>("POST", "/api/routines/save", r);
  }
  /** Save how this agent did something as a skill (or update one it learned before, by name or slug). */
  saveSkill(s: { name: string; description?: string; content: string; slug?: string }) {
    return this.request<{ skill: Skill }>("POST", "/api/skills/learn", s);
  }
  runRoutine(routineId: string) {
    return this.request<{ ok: boolean }>("POST", `/api/routines/${routineId}/run`);
  }
  uploadFile(name: string, data: Uint8Array, mime = "application/octet-stream", channelId?: string) {
    return this.request<{ id: string; name: string; size: number }>("POST", "/api/files", data, {
      "content-type": "application/octet-stream",
      "x-filename": encodeURIComponent(name),
      "x-mime-type": mime,
      ...(channelId ? { "x-channel-id": channelId } : {}),
    });
  }
  async downloadFile(id: string): Promise<{ data: Uint8Array; name: string; mime: string }> {
    const res = await (this.opts.fetch ?? fetch)(`${this.url}/api/files/${id}`, { headers: { authorization: `Bearer ${this.opts.token}`, ...(this.opts.agentId ? { "x-wisp-agent": this.opts.agentId } : {}) } });
    if (!res.ok) throw new WispError(`download failed: ${res.status}`, res.status);
    const cd = res.headers.get("content-disposition") ?? "";
    const name = decodeURIComponent(cd.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? id);
    return { data: new Uint8Array(await res.arrayBuffer()), name, mime: res.headers.get("content-type") ?? "application/octet-stream" };
  }
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return { error: t };
  }
}

/** What the hub says after an agent saves a note: hints only (similar notes to merge into, names it could link). */
export interface SavedNote {
  path: string;
  similar?: { path: string; title: string }[];
  linkable?: string[];
}
