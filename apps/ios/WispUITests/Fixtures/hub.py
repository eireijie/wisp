#!/usr/bin/env python3
"""Local hub for TourTests and DeclutterTests. Run on the Mac; the iOS simulator shares localhost."""
import argparse
import json
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

USER = dict(id="u1", email="sam@example.test", name="Sam", preferredName="Sam", timezone="America/New_York")
AGENT = dict(id="a1", name="Nova", handle="nova", harness="codex", nodeId="n1", computerId=None, model=None, groups=[], instructions="Research carefully.", settings={}, status="online")
TASK = dict(id="t1", title="Find three venues for the offsite", brief="Compare prices and accessibility. Keep it under $5k.", status="done", result="Three venues are ready for you to review.", toAgentId="a1", channelId="c1", threadId=None, createdAt="2026-10-18T12:00:00Z", updatedAt="2026-10-18T12:00:00Z", **{"from": {"kind": "user", "id": "u1"}})
NOTE = dict(path="shared/Welcome.md", title="Welcome", content="# Welcome\n\nOur team keeps plans and decisions here.\n\n**Next step:** choose a venue.\n\n[[Welcome]]", tags=["planning"], links=["Welcome"], updatedAt=1792324800000, access="manage", backlinks=[], editedBy="Sam", editedAt="2026-10-18T12:00:00Z")
CHANNEL = dict(id="c1", name="general", kind="channel", topic="Our workspace", createdAt="2026-10-18T12:00:00Z", joined=True, memberCount=2, unread=0, settings={}, pinnedIds=[])
NODE = dict(id="n1", name="Sam's Mac", ownerId="u1", ownerName="Sam", mine=True, shared=False, online=True, paused=False, role="headless", harnesses=[dict(id="codex", version="1.0")])
TEAM = dict(id="te1", name="research", emoji="🔎", description="Find answers with sources.", channelId="c1", leadId="a1", reportsTo=None, members=[dict(agentId="a1", role="Lead", roleNotes="Coordinate research", managerId=None)], baseBranch="main", folder="teams/research")
DATA = {
    "/api/me": dict(kind="user", user=USER, role="owner", workspace=dict(id="w1", name="Wisp Studio"), prefs=dict(experience="advanced", clock="auto", sendWith="enter", toolCalls="collapsed")),
    "/api/channels": [CHANNEL], "/api/agents": [AGENT], "/api/sections": [], "/api/nodes": [NODE], "/api/teams": [TEAM],
    "/api/members": [dict(**USER, role="owner")], "/api/computers": [], "/api/approvals": [], "/api/me/push": dict(available=False, devices=0),
    "/api/tasks": [TASK], "/api/settings/lead": dict(lead="a1", leadId=None), "/api/vault/notes": [NOTE], "/api/vault/note": NOTE,
    "/api/vault/history": [], "/api/vault/search": [NOTE], "/api/vault/resolve": dict(path=NOTE["path"]),
    "/api/memory/profile": dict(person=dict(id="u1", name="Sam"), level="manage", items=[dict(path="people/u1/preferences/short.md", kind="preference", text="Prefers short answers with examples", pinned=True, by="Nova")]),
    "/api/routines": [dict(id="r1", agentId="a1", name="Monday dinner ideas", notePath=NOTE["path"], schedule="0 9 * * 1", timezone="America/New_York", enabled=True, status="ready")],
    "/api/agents/a1/background": dict(background=dict(enabled=False, everyMinutes=60, focus="My inbox and calendar", quietStart="22:00", quietEnd="08:00", dailyCap=24), followups=[], sources=[dict(kind="memory", name="Shared", detail="Read and edit")], usage=dict(checksToday=0), defaultDailyCap=24),
    "/api/agents/a1/models": dict(catalog=dict(models=[], efforts=[])), "/api/agents/a1/runs": [],
    "/api/skills": [dict(id="s1", name="Meeting notes", description="Use when asked to summarize a meeting.", content="# Meeting notes\nList decisions and next steps.", agentIds=["a1"], tags=["work"], source="custom")],
    "/api/connectors": [dict(id="co1", name="Notion", kind="mcp-http", url="https://mcp.notion.com/mcp", enabled=True, agentIds=["a1"], auth=dict(required=True, signedIn=False))],
    "/api/invites": [], "/api/me/sessions": [dict(id="se1", label="Wisp on iPhone", current=True)],
    "/api/channels/c1/messages": dict(messages=[dict(id="m1", channelId="c1", author=dict(kind="agent", id="a1"), body="Done. I'll check your inbox less often and stay quiet a bit later.", parts=[dict(type="change", changeId="ch1")], createdAt="2026-10-22T12:00:00Z")], replyCounts={}),
    "/api/changes": [dict(id="ch1", userId="u1", agentId="a1", lines=["Checks: every hour → every 2 hours", "Quiet hours: 10pm – 8am"], createdAt="2026-10-22T12:00:00Z", undoneAt=None)],
    "/api/background/allowance": dict(dailyTokens=1000000, todayTokens=412000, estimated=False, agents=[dict(agentId="a1", tokens=268000, checks=7), dict(agentId="a2", tokens=144000, checks=4)]),
}
DATA["/api/agents"] = [AGENT, dict(AGENT, id="a2", name="Pip", handle="pip")]
DATA["/api/agents/a1/background"]["background"].update(enabled=True, focus="my inbox and calendar", lastAt=(datetime.now(timezone.utc) - timedelta(minutes=25)).strftime("%Y-%m-%dT%H:%M:%SZ"), lastNote="Nothing new in your inbox")
DATA["/api/agents/a1/background"]["usage"] = dict(checksToday=7, todayTokens=268000, lastTokens=38000)
DATA["/api/agents/a1/background"]["followups"] = [dict(id="f1", agentId="a1", userId="u1", dueAt="2026-10-23T12:00:00Z", note="See if the landlord replied")]
def add_agent_data():
    """Models, a computer, runs, people and apps for the agent profile pages."""
    now = datetime.now(timezone.utc)
    iso = lambda minutes: (now - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")
    DATA["/api/agents"][0].update(name="Ghosty", handle="ghosty", computerId="cp1", model="sol-6.1", status="busy",
                                   settings=dict(effort="high", description="Release manager for the web app", role="Release manager", roleNotes="Cuts weekly releases and writes the notes.", respondTo="anyone", createdBy="u1"))
    DATA["/api/agents"][0]["instructions"] = "## What it owns\n- The release checklist\n- notes/release.md"
    DATA["/api/agents"][1].update(name="Pappy", handle="pappy", harness="claude-code")
    DATA["/api/computers"] = [dict(id="cp1", name="Ghosty's desk", kind="vm", nodeId="n1", status="ready", statusText="Ready", agents=["a1"], online=True),
                              dict(id="cp2", name="Shared desk", kind="vm", nodeId="n1", status="ready", statusText="Ready", agents=["a2"], online=True)]
    DATA["/api/members"] = [dict(**USER, role="owner"), dict(id="u2", email="maya@example.test", name="Maya Chen", preferredName="Maya Chen", role="member"), dict(id="u3", email="sam.o@example.test", name="Sam Ortiz", preferredName="Sam Ortiz", role="member")]
    DATA["/api/agents/a1/models"] = dict(catalog=dict(
        models=[dict(id="sol-6.1", label="sol 6.1", description="Newest, best for code", efforts=["low", "medium", "high", "xhigh"], defaultEffort="medium", fast=dict(description="Quicker replies, uses your allowance faster")),
                dict(id="gpt-5.2-codex", label="gpt-5.2-codex", description="Steady all-rounder", efforts=["low", "medium", "high"], defaultEffort="medium")],
        efforts=["low", "medium", "high"], defaultModel="sol-6.1", defaultEffort="medium"))
    DATA["/api/agents/a1/runs"] = [
        dict(id="run1", status="running", kind="message", trigger="Write the release notes for this week", channelName="general", channelId="c1", createdAt=iso(2), finishedAt=None),
        dict(id="run2", status="done", kind="message", trigger="Review pull request 214", channelName="general", channelId="c1", createdAt=iso(180), finishedAt=iso(176)),
        dict(id="run3", status="done", kind="background", trigger="Background check - Ghosty", channelName=None, channelId=None, createdAt=iso(400), finishedAt=iso(399)),
        dict(id="run4", status="failed", kind="message", trigger="Open the staging site", channelName="general", channelId="c1", createdAt=iso(1500), finishedAt=iso(1499), error="codex is not signed in", hint="Codex needs signing in on its device."),
    ]
    DATA["/api/routines"] = [
        dict(id="r1", agentId="a1", name="Weekly release notes", notePath=NOTE["path"], schedule="0 9 * * 5", timezone="America/New_York", enabled=True, status="ready", channelId="c1"),
        dict(id="r2", agentId="a1", name="Clean up the downloads folder", notePath=NOTE["path"], schedule=None, timezone="America/New_York", enabled=False, status="ready"),
    ]
    DATA["/api/agents/a1/harness"] = dict(possible=True, inComputer=True, signedIn=True, computerId="cp1")
    DATA["/api/agents/a1/apps"] = []
    DATA["/api/access/agents/a1"] = dict(rules=[dict(path="agents/a1", subject=dict(kind="agent", id="a1"), level="manage", startup=True, builtin=True)], sharedOut=[])
    DATA["/api/settings/agents"] = dict(askBefore=["send", "spend"], maxHops=6, maxRunsPerMinute=20, defaultAccess="edit")
    DATA["/api/settings/agent-defaults"] = dict(harness="codex", model=None, computer="own-vm", nodeId="n1")
    DATA["/api/voice/settings"] = dict(listen="device", speak="device")
    DATA["/api/vault/notes"] = [NOTE, dict(path="agents/a1/Release checklist.md", title="Release checklist", content="# Release checklist", updatedAt=int(now.timestamp() * 1000), access="manage"),
                                dict(path="agents/a1/How Sam likes updates.md", title="How Sam likes updates", content="Short.", updatedAt=int((now - timedelta(days=3)).timestamp() * 1000), access="manage")]
    DATA["/api/vault/history"] = [dict(hash="h2", message="Refined", author="@ghosty", date=iso(60 * 24 * 2)), dict(hash="h1", message="First version", author="Sam", date=iso(60 * 24 * 9))]
    DATA["/api/nodes"] = [dict(NODE, capabilities=dict(vm=dict(ok=True), screen=dict(ok=True)), discovered=[dict(key="sage", harness="claude-code", name="Sage", description="Reads and summarizes", path="~/.claude/agents/sage.md", hasSoul=True, memoryCount=2)])]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/ws":
            self.send_error(426)
            return
        value = DATA.get(path)
        self.send_response(200 if value is not None else 404)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(value if value is not None else {"error": "No fixture for this route"}).encode())
    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")
    def reply(self, value):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(value).encode())
    def do_PUT(self):
        path, patch = urlparse(self.path).path, self.body()
        if path == "/api/background/allowance":
            DATA[path]["dailyTokens"] = patch.get("dailyTokens")
            return self.reply(DATA[path])
        if path.startswith("/api/agents/") and path.endswith("/background"):
            DATA[path]["background"].update(patch)
            return self.reply(dict(ok=True))
        self.send_error(404)
    def do_PATCH(self):
        path, patch = urlparse(self.path).path, self.body()
        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "agents"]:
            for agent in DATA["/api/agents"]:
                if agent["id"] == parts[2]:
                    settings = patch.pop("settings", None)
                    agent.update({k: v for k, v in patch.items()})
                    if settings:
                        agent["settings"] = {**(agent.get("settings") or {}), **settings}
                    return self.reply(agent)
        if len(parts) == 3 and parts[:2] == ["api", "routines"]:
            for routine in DATA["/api/routines"]:
                if routine["id"] == parts[2]:
                    routine.update(patch)
                    return self.reply(routine)
        self.send_error(404)
    def do_POST(self):
        path = urlparse(self.path).path
        self.body()
        if path.startswith("/api/changes/") and path.endswith("/undo"):
            for change in DATA["/api/changes"]:
                if path == f"/api/changes/{change['id']}/undo":
                    change["undoneAt"] = "2026-10-22T12:05:00Z"
            return self.reply(dict(ok=True))
        # marking read and the like: nothing to keep
        self.reply(dict(ok=True))
    def log_message(self, *args):
        pass
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18747)
    parser.add_argument("--empty", action="store_true")
    parser.add_argument("--agents", action="store_true", help="richer agent data: models, a computer, runs, people (for the agent screens)")
    args = parser.parse_args()
    if args.agents:
        add_agent_data()
    if args.empty:
        for path in ["/api/agents", "/api/tasks", "/api/vault/notes", "/api/nodes", "/api/teams", "/api/skills", "/api/connectors", "/api/routines"]:
            DATA[path] = []
        DATA["/api/memory/profile"]["items"] = []
        DATA["/api/settings/lead"] = dict(lead=None, leadId=None)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
