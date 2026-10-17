# Warren usability test (beginner persona)

**Date:** 2026-10-17
**Build:** worktree at commit `f8d3d23` (Settings → Updates & about shows the same), package version 0.0.1, web app built with `npm run build`, hub run with `tsx apps/hub/src/main.ts`.
**Persona:** "Martin", 42, limited technical knowledge, has never used AI agents, automation software or developer tools. Everything in first person below is the persona's reaction, not a recruited participant's.
**Tester:** Claude (Fable 5.1) driving the built-in browser. No application source code was modified. I did not read the application's UI source to learn how features work; the only code I looked at was the device CLI's command-line help and the config/guard logic, as test administration, to make sure running the device daemon would not touch the owner's existing workspace.

---

## 1. Verdict and summary

**Verdict: Warren is not yet something a non-technical person can set up and get a first useful answer from on their own.** The interface is well written sentence by sentence, the screens are tidy, and several everyday things (saving a preference, finding it again, scheduling a weekly routine, turning background activity on and off) work with little friction. But the path to the first real reply runs straight through a Terminal command, an unexplained choice between twelve "harnesses", and a sign-in to a paid developer tool, and the app lets a beginner create an agent, send it tasks and walk away believing it is working when nothing will ever answer.

| Area | Rating | One-line reason |
|---|---|---|
| Understanding what Warren is | Weak | README and first screens talk about agents, harnesses, hubs, devices, VMs; nowhere a plain "it's an assistant that can do X for you". |
| Installation (docs) | Major barrier | Mac download exists (good), but the README/INSTALL text is written for developers and AI agents; "Quick start" is a `curl … | bash` command. |
| Setup wizard | Blocked at step 1 of 5 | Step 1 requires pasting a Terminal command; the Continue button is disabled until a device connects; only escape is "Skip setup". |
| Adding an agent | Completes, but misleading | Works in three clicks, yet asks "Choose a harness" (12 brand names, no explanation) and lets me pick an offline device and "Choose later" for a computer. |
| First useful task (dinners, thank-you note) | Failed | Messages and tasks are accepted and silently queued forever ("queued until its node reconnects"). |
| Remember a preference / find it later | Works | About you → Add, then ⌘K search finds it. |
| Connect email | Stopped at a trust question | Gmail is offered by "mintmcp.com", labelled "Not from the app's maker: only add servers you trust"; no way for me to judge that. |
| Weekly reminder | Works (configuration only) | Write a routine → Every week → Monday 9:00. Actual run not verified. |
| Stop automatic activity | Mostly works | Background toggle on/off works; routine has an On/Off switch in Schedule; trash icon on the routine did nothing in my browser (unverified whether a confirm dialog was swallowed). |
| Navigation | Learnable but wide | 10 sidebar destinations + 12 agent tabs + 14 settings pages; several raw IDs and internal messages leak into the UI. |
| Phone width (390×844) | Good | Layouts reflow cleanly; bottom tab bar; no horizontal scroll. |

---

## 2. Environment and limits

**Test administration (outside the persona, required technical help, does not count as a beginner install):**

- `npm ci` and `npm run build` in a clean worktree; hub started with `WARREN_DATA_DIR=<scratchpad>/usertest-data PORT=4951 HOST=127.0.0.1 npx tsx apps/hub/src/main.ts`. The owner's `./data` folder was never used.
- Browser: Claude desktop app's built-in browser at 1280×860 (emulated) and a 390×844 phone check; viewport reset afterwards.
- Synthetic account "Martin Test" / martin@example.test / throwaway password; workspace "Martin's Home"; device entry "my-mac"; agent "Helper" (Claude Code harness, no computer, job: "Help me with everyday things like dinners, shopping lists and notes").
- No real AI provider was connected and no money was spent. The owner's Claude Code sign-in exists on this Mac, so I never let a run execute.
- **Device daemon (administrator only):** after recording the beginner outcome, I ran `warren node start` against the test hub with an isolated `--dir` and `{"paused": true}` pre-set, so the device showed **online** but every queued run failed with "my-mac is paused" instead of running Claude Code. The CLI first refused because the owner's own device service (`ai.warren.node`) is installed; I bypassed that with the documented `WARREN_SERVICE` env var. I did not create a VM (it would have used the owner's Apple `container` setup), did not run `warren setup`, and did not sign anything in.
- **Not done:** the DMG was not downloaded; `/Applications/Warren.app` was not opened (its first screen offers to create a server or join one, which could touch the owner's existing workspace, so I skipped it); no connector was authorised; no skill was installed; no team was created; no routine actually ran; no AI reply was ever received, so answer quality, approvals during execution, computer watching/taking over, teaching a task, and recovery after a device reconnects are all **untested**.
- Evidence screenshots are in `usability-evidence-2/` (49 files, numbered in walkthrough order). The two screens that showed a device token were deliberately not saved.
- The hub and device daemon were stopped at the end.

---

## 3. Numbered walkthrough

| # | What I did (as Martin) | What happened | Outcome |
|---|---|---|---|
| 1 | Read README.md | First paragraph: "Chat with Claude Code, Codex, Hermes, Gemini CLI and other agents in Slack-style channels. Each agent gets its own computer…". I don't know any of those names. The Download section says to right-click and Open because it "isn't signed by Apple yet", which sounds like a warning not to. The "Quick start" is a `curl … | bash` command, then "Install the hub", "Connect a device" and "Add an agent". | Understood roughly that it's a chat with AI helpers; did not understand what I would need to pay for or install. |
| 2 | Read INSTALL.md | Titled "a guide for AI agents". Tables of Node.js, git, Docker, "harnesses", LXC, systemd. | Closed it; clearly not for me. |
| 3 | Opened the app (admin started it) | "Set up Warren – You'll be the owner of this workspace." Name, workspace name, email, password. | Fine. Didn't know why I needed an email/password for something on my own computer. (evidence 01) |
| 4 | Setup wizard step 1 of 5, "Where will your agents live?" | Asked to "Name this device" (pre-filled `my-mac`). Text mentions "connects out… behind routers and firewalls" and "agents get their own VMs". | Continued, unsure. (02) |
| 5 | "Connect my-mac" | A grey box with a long command, tabs "Mac or Linux / Windows / Warren already installed", text "In Terminal. It installs Warren in ~/warren (it needs git and Node 22+…)", "Waiting for my-mac to connect…", Continue button greyed out as "Waiting". Clicking the step-2 segment of the progress bar did nothing. | **Blocked.** I don't know what Terminal is. Only way out: "Skip setup" top-right. (token screen not saved) |
| 6 | Clicked Skip setup | Landed on an empty Dashboard: Agents 0, Teams 0, Tasks 0, with links "Add your first agent", "Make a team", "Hand an agent some work". No "Get started" / "finish setup" item in the sidebar. | Lost; nothing says what I should do first. (03) |
| 7 | Opened #general and typed "Can you help me plan dinners for this week and make a shopping list?" | The message appeared under my name. Nothing else happened. The channel header says "@mention an agent to bring it in. New here? Get started". | Failed. No reply, no hint that nobody is listening. (04, 05) |
| 8 | Agents → New agent | Step 1 "Who's joining?" with a cute ghost and a name field. Step 2 "Choose a harness – How should Helper work?": Claude Code (pre-selected), Codex, Hermes, Gemini CLI, OpenCode, Goose, Kimi CLI, Qwen Code, Cursor, OpenClaw, Grok, Custom. No descriptions, no prices, no "which do I have?". Step 3 "Set up Helper": Handle, Device "my-mac (offline)", Computer: "New VM on my-mac (Connect the device to check)", "Your own screen", "Choose later", a checkbox "Run it headless", a Job dropdown (Chief of Staff, Inbox Manager, Sales Outbound, Account Manager, Research, Expense Manager, Talent Scout, Bug Reproduction, Product Performance) and a free-text job. | Completed by accepting defaults and "Choose later". Felt like guessing. (06–09) |
| 9 | Agent page for Helper | Tabs: Overview, Look, Soul, Instructions, Model, Device, Computer, Background, Routines, Permissions, Connect, Runs. Overview shows "offline", Model "Harness default", Computer "None yet", Access "Can edit files", a "Soul" block in Markdown (`## Personality`). | I can see a lot of knobs; I don't know which matter. (10–14) |
| 10 | Clicked "Message" and asked Helper for a Monday–Friday dinner plan | Message sent; under it in small grey text: "@helper is offline. The request is queued until its node reconnects." | Failed. What is a node? How do I reconnect it? (15) |
| 11 | New task (sidebar): "Write a thank-you note to my neighbour Sue for watering the plants" → Send to Helper | Jumped into Helper's DM plus a Thread panel. A message **under my own name** reads: "Helper New task … (task_N481uJnk33vH) … (You're the only agent so far, so this one's yours to do.) When finished, report back with the task result (warren tool task_update, status done)." Then the same offline/queued note. | Failed, and I appear to have written robot instructions I never typed. (24, 25) |
| 12 | About you → typed "I am vegetarian and I do not like spicy food" → Add | Saved instantly, shown "by Martin Test · just now" with pin/edit/delete icons. | Works. (17, 20) |
| 13 | Search (⌘K) "vegetarian" | Found it under MEMORY, but the result line shows `people/usr_yN7fNNXTN6NP/prefere…` as its location. | Works; the path is noise. (26) |
| 14 | Memory page | Tree: Shared / Welcome to Martin's Home; People / Martin Test; Agents / @helper. Right side: "Obsidian is the best place to write and organize notes… Open in Obsidian". | Confusing: told to use another app I've never heard of. (18) |
| 15 | Connectors → Gmail → Add | Catalogue lists Zapier, Notion, Gmail (mintmcp.com), Outlook, GitHub, Linear, Atlassian, Airtable, Stripe, Supabase, Neon, Vercel, Cloudflare… Dialog: "Not from the app's maker: only add servers you trust, since agents send them data." Button "Connect and sign in". | Stopped. I can't tell whether "mintmcp.com" is safe to hand my email to. (16, 33) |
| 16 | Helper → Routines → Write a routine: "Bin day reminder", step "1. Remind me to put the bins out.", Every week → Monday 09:00 | Saved: "Every Monday at 9am · next Mon 9:00 AM", with Steps / Schedule / Run now. Hint says "Every Monday at 9am, in America/New_York" although my profile time zone is "Not set (agents see UTC)". | Configured. Whether it would run, and in which time zone, unverified. (27–29) |
| 17 | Helper → Background → toggle on, then off | On: a panel appears with "waiting for its device to come online", "1 of 24 checks today", pace, model, quiet hours. Off: the panel collapses, but "Last checked 4m ago · Its note from last time: The check failed…" and "1 of 24 checks today" stay. | Works; a check was counted the instant I toggled it, before I'd read anything. (12, 31) |
| 18 | Routine → trash icon (twice) | Nothing visible happened; the routine stayed. The hub log shows no delete request reached it, so most likely a browser confirm box was auto-dismissed by my test browser. Schedule dialog has an On/Off switch, which is the alternative. | Could not verify deletion. |
| 19 | Settings (via the avatar menu at the bottom of the sidebar) | Menu: Profile, Preferences, Notifications, Appearance, "Martin's Home settings", Invite people, Sign out. Settings has 6 account + 8 workspace pages including "Agent runtimes", "Connections", "Data & export". Profile time zone is a 400-entry dropdown. | Findable only because I clicked my own name. (30, 32) |
| 20 | Computers → Add computer; Devices page | "A VM on one of your devices – None of your devices can run VMs yet: install Docker on one." "Your own screen". "An Orgo cloud computer – Add your Orgo API key in Settings → Computers first." Devices page: my-mac offline, dropdown "For agents, it: Not chosen yet / runs their computers (VMs) / lends them its own screen / runs them headless". | Did nothing; every option needs something I don't have. (22, 23, 34) |
| 21 | Phone width | Dashboard, DM, agent page, chats list all reflow with a bottom bar Chats / Agents / Search / Memory / You. Wizard shows "my-mac – Not running. Start it there with `warren node start`". | Good. (36–40) |
| 22 | **Administrator:** connected the device (paused) and re-opened Get started | Device shows **online · Paused at the device**. Wizard step 2 "What should my-mac do for your agents?" (Run their computers / Lend them this screen / Neither: run them headless) with a green "Apple's container is running and the VM image is ready" (detected the owner's setup). Step 3 "Meet Helper". Step 4 "Helper is in – Claude Code runs on my-mac and uses its sign-in there. NOT SIGNED IN TO CLAUDE CODE ON MY-MAC YET? `claude` … Run this there once, then /login." Step 5 "First task" pre-filled with "@helper Hi! Introduce yourself in two sentences, then save a short note about what you're good at to your memory as me/strengths.md." Sent → "Helper · thinking", then in #general: "@helper's device is paused. The request is queued until it's resumed there." In the DM the earlier task shows red "Run failed: my-mac is paused; ask again once someone resumes it there". The DM footer still said "@helper is offline" after the device was online. | Later wizard steps are friendlier than step 1, but step 4 is a second Terminal + account barrier. (41–48) |

---

## 4. Realistic-scenario results

| Scenario | Could Martin do it alone? | What happened |
|---|---|---|
| Plan dinners and a shopping list | **No** | Typed it in #general (ignored) and in Helper's DM (queued forever). Never got an answer. |
| Write a thank-you note | **No** | New task works as a form, but the result is a queued task and a technical message under my name. |
| Remember a preference | **Yes** | About you → type → Add. Clear and fast. Whether an agent would honour it: untested. |
| Connect email | **No (stopped at a trust decision)** | Gmail card is from a third party; the dialog warns me to trust only servers I trust; nothing helps me decide. Zapier is suggested as the one-sign-in route but also unexplained. |
| Set up a weekly reminder | **Yes, configuration only** | Routines → Write a routine → Every week. Time-zone mismatch (profile unset / hint says New York). Actual delivery untested. |
| Find something saved earlier | **Yes** | ⌘K / Search found the preference; Memory tree also shows "Martin Test" folder. |
| Stop automatic activity | **Mostly** | Background toggle works; routine Schedule has an On switch; trash icon unverified; queued chat messages have no cancel control I could find. |
| Understand what to do after Skip setup | **No** | Nothing on the dashboard or sidebar says "setup not finished"; the only link back is a small "Get started" inside #general's empty state. |

---

## 5. Prioritised findings

Severity is about impact on a first-time, non-technical user. **Verified** = I saw it on screen in this test. **Potential / untested** = a concern I could not exercise.

### Critical

#### C1 — The onboarding wizard dead-ends on a Terminal command (Verified)
*Martin:* "Step 1 of 5 and I'm already being told to paste a line that starts with `curl -fsSL` into something called Terminal, and it needs 'git and Node 22+'. The Continue button is grey and says 'Waiting'. I clicked the next bar in the progress line and nothing happened. The only thing I can press is 'Skip setup', so I did, and now I don't know what I skipped."
*Why it's confusing:* the wizard assumes the user can open a terminal, understands "device", "token", "VM engine", and will keep a window open. Nothing explains what happens if they don't. The disabled Continue gives no alternative path.
*Change:* detect that the hub is running on this same Mac (it was) and offer **"Use this Mac"** as a one-click option that connects it without a terminal (the desktop app apparently already does this; the web app should hand off to it or download it). Keep "Connect another computer" with the command behind an "Advanced" disclosure. Replace "Waiting" with a readable state ("Waiting for my-mac — nothing happens until the command above has been run there. [I can't do this] → explains alternatives").
*Evidence:* 02-wizard-step1-device.jpg; the command screen is described in step 5 of the walkthrough (not saved because it shows a token).

#### C2 — An agent that can never answer looks finished and swallows work (Verified)
*Martin:* "I made Helper in three clicks. It has a face, a name and a page. I sent it my dinner question and a task. Both say 'queued until its node reconnects'. It's been ten minutes. Is it slow? Is it broken? I've no idea what a node is, so I can't fix it."
*Why it's confusing:* creation succeeds with an offline device and no computer; chat and New task accept input with only a small grey footnote. There is no readiness check, no "Setup incomplete" badge, and no cancel/edit control on queued work. On the Overview page everything reads like a normal profile ("Works on its own").
*Change:* give each agent a visible readiness checklist (Device connected · AI signed in · Test reply received) and label it **"Not ready yet"** until all pass. When the user tries to message a not-ready agent, show an inline card: "Helper can't answer yet. [Finish setting it up]" with the one next step, plus **Cancel** on anything queued. Rename "node" to "device" everywhere the user sees it.
*Evidence:* 10-agent-overview.jpg, 15-dm-queued-node-reconnects.jpg, 25-task-sent-internal-text.jpg, 38-phone-agent-overview-queued-runs.jpg.

#### C3 — "Choose a harness" asks a question no beginner can answer, and the paid-account requirement is hidden until step 4 (Verified)
*Martin:* "Twelve tiles with logos: Claude Code, Codex, Hermes, Gemini CLI, OpenCode, Goose, Kimi CLI, Qwen Code, Cursor, OpenClaw, Grok, Custom. No sentence under any of them. Which one do I own? Does any cost money? I left the first one ticked. Much later the wizard told me to run `claude` and then `/login` — so I need an account with someone, and it never said who or how much."
*Why it's confusing:* "harness" is an internal word; the tiles are brand names of developer tools; cost, account, and installation needs are never stated; the sign-in step is a terminal command again.
*Change:* rename the step **"Which AI service will Helper use?"**, show two or three recommended options with one plain line each ("Claude — needs a Claude subscription, signs in on this Mac"), add **"I'm not sure / I don't have one"** that explains what to buy or sign up for, and put the full list under "More". Say up front, before the wizard starts, that Warren is free but the AI behind it is a separate account.
*Evidence:* 08-new-agent-choose-harness.jpg, 45-admin-wizard-step4-harness-login.jpg.

### High

#### H1 — Messages in #general go nowhere, with no feedback (Verified)
*Martin:* "I typed my question in the main chat like in any app. It just sat there under my name."
*Change:* when a message in a channel mentions no agent and an agent exists, show a small prompt "Nobody is listening — send this to Helper?" with a one-click button; when no agent exists, show "Add a helper to get answers" inline instead of only in the empty-state header.
*Evidence:* 05-message-no-reply.jpg.

#### H2 — Internal instructions and IDs are posted as if the user wrote them (Verified)
*Martin:* "Under my name it says '(task_N481uJnk33vH)' and 'report back with the task result (warren tool task_update, status done)'. I never wrote that."
*Change:* render tasks as a card (request, assignee, status, Cancel/Edit) and keep the system prompt for the agent out of the human-visible message; put IDs under a "Details" disclosure.
*Evidence:* 25-task-sent-internal-text.jpg, 37-phone-dm.jpg.

#### H3 — After "Skip setup" there is no way back that a beginner would find (Verified)
*Martin:* "I skipped because I was stuck. The dashboard shows zeros and three links; none says 'finish setting up'. I only found 'Get started' later because it is a small link in the empty #general channel."
*Change:* a persistent "Setup not finished — Helper can't answer yet [Continue setup]" banner on the Dashboard and the agent page until the first successful reply; a "Get started" entry in the sidebar.
*Evidence:* 03-dashboard-after-skip.jpg, 04-general-channel-empty.jpg.

#### H4 — Connecting Gmail requires judging a third-party server's trustworthiness (Verified)
*Martin:* "The Gmail card says 'mintmcp.com', not Google. The dialog warns: 'Not from the app's maker: only add servers you trust, since agents send them data.' I can't judge that. Zapier is 'official' but I don't know what Zapier is either."
*Change:* for the handful of everyday apps (Gmail, Google Calendar, Outlook), either integrate directly or clearly mark one route as **"Recommended for most people"** with a plain explanation of who will see the data; hide "MCP server", "Remote · needs a key" and the long developer catalogue (Supabase, Neon, Vercel, Cloudflare, Stripe…) behind "Developer tools".
*Evidence:* 16-connectors.jpg, 33-add-gmail-dialog.jpg.

#### H5 — Agent creation form is full of infrastructure choices (Verified)
*Martin:* "'Handle', 'Device: my-mac (offline)', 'Where Warren starts its harness', 'New VM on my-mac — Connect the device to check', 'Run it headless: no computer, so no apps or websites'. And the job list is Chief of Staff, Sales Outbound, Talent Scout, Bug Reproduction — I'm one person at home."
*Change:* in the first-run path, ask only name and what you want help with; pick device/computer automatically (this Mac) and explain the one consequence in a sentence. Add home-user job presets ("Everyday helper", "Meal planner", "Family admin") or drop the dropdown for solo workspaces. Move Handle/VM/headless to the agent's settings page.
*Evidence:* 09-new-agent-workspace-step.jpg.

#### H6 — Status is stale/inconsistent across screens (Verified)
*Martin:* "After the device came online, the DM footer still said '@helper is offline. The request is queued until its node reconnects' while the Devices page said online; the Background page said 'waiting for its device to come online' and '1 of 24 checks today' when I had just turned it off; the Overview said 'offline' with three 'queued' runs, one of them titled '—'."
*Change:* one status source shown identically everywhere ("Waiting for my-mac", "Working", "Needs you", "Done", "Failed"); refresh footers when the device state changes; never count a check that didn't run; give background runs a readable title.
*Evidence:* 42-admin-dm-run-failed-paused.jpg, 31-background-on-settings.jpg, 38-phone-agent-overview-queued-runs.jpg.

#### H7 — Routine schedule says "in America/New_York" while the profile time zone is "Not set (agents see UTC)" (Verified mismatch; actual run time untested)
*Martin:* "I never told it where I live. Will my Monday 9am reminder arrive at 9am?"
*Change:* ask for (or auto-detect and confirm) the time zone once during setup; show the same zone in the routine hint and the profile.
*Evidence:* 28-routine-weekly-schedule.jpg, 32-settings-profile.jpg.

### Medium

#### M1 — README and INSTALL are written for developers and "AI agents" (Verified)
*Martin:* "The README's first paragraph lists five products I've never heard of. 'Quick start' is a command. INSTALL.md literally says it's 'a guide for AI agents'."
*Change:* add a 5-line "For everyone" section at the top: what Warren does in plain words, what you need (a Mac, a Claude or similar account), the three steps of the first run, and a link to a screenshots-based guide. Keep the current text under "For developers".

#### M2 — Raw identifiers leak into the UI (Verified)
Search results show `people/usr_yN7fNNXTN6NP/prefere…`; Background "What it can see" lists `people/usr_yN7fNNXTN6NP/ memory`; the first-task template says "save a short note … as me/strengths.md"; the Permissions page lists folder names like `shared`.
*Change:* show "Martin Test › Preferences", "Your memory", "Shared notes"; keep paths only in a Details disclosure.
*Evidence:* 26-search-finds-preference.jpg, 30-user-menu-and-background-raw-id.jpg, 46-admin-wizard-step5-first-task.jpg.

#### M3 — Memory page sends me to Obsidian (Verified)
*Martin:* "'Obsidian is the best place to write and organize notes.' I don't have Obsidian. Is this app not enough?"
*Change:* lead with "Your notes and what Helper has learned about you. [New note] [Search]"; mention Obsidian only under "Advanced: edit in another app".
*Evidence:* 18-memory-page.jpg.

#### M4 — Settings are only reachable by clicking your own name (Verified)
*Change:* add a Settings entry to the sidebar (or a gear next to the workspace name); split "Agent runtimes", "Connections", "Data & export" under an "Advanced" heading.
*Evidence:* 30-user-menu-and-background-raw-id.jpg, 32-settings-profile.jpg.

#### M5 — Twelve agent tabs with overlapping meaning (Verified)
Look, Soul, Instructions, Model, Device, Computer, Background, Routines, Permissions, Connect, Runs. *Martin:* "Soul versus Instructions versus Skills versus Routines — which one do I use to tell it I'm vegetarian?" (Answer: none; it's About you.)
*Change:* collapse to "About Helper" (name, look, personality, job), "What it can do" (apps, computer, permissions), "On its own" (background, routines), "Activity"; put Model/Device/Connect under Advanced.
*Evidence:* 10-agent-overview.jpg.

#### M6 — "Computers" and "Devices" are two pages for what feels like one thing (Verified)
*Martin:* "Devices shows my Mac. Computers says I have none and must install Docker or add an 'Orgo API key'."
*Change:* one page, "Where Helper works", with the Mac listed and a single optional "Give Helper its own desktop (advanced)".
*Evidence:* 22-computers-empty.jpg, 23-devices-offline.jpg, 34-add-computer-dialog.jpg.

#### M7 — The Background feature is described as unlimited autonomy with the spending explained in jargon (Verified)
"Each check is a run of Helper, so it uses your harness's plan like any other message." "Token use: not reported by this harness."
*Change:* "Each check uses your AI account like a normal message. Up to 24 a day (change)". Hide model/effort pickers under Advanced.
*Evidence:* 12-agent-background-tab.jpg, 31-background-on-settings.jpg.

#### M8 — Skills shop is work-oriented (Verified)
All 14 skills are about GitHub issues, pull requests, status reports, customer tickets, bookkeeping, competitors. Nothing a household would install.
*Change:* add everyday skills (meal planning, trip packing list, letter drafting) and show them first for personal workspaces.
*Evidence:* 21-skills-shop.jpg.

#### M9 — Deleting a routine gave no feedback (Potential / untested)
The trash icon did nothing in my test browser and no delete request reached the hub; most likely a native confirm() dialog was auto-dismissed. In a normal browser it may work. Either way, prefer an in-app confirmation ("Delete 'Bin day reminder'? [Delete] [Keep]") over a browser popup.

#### M10 — Device page offers a "Paused at the device" state that can only be changed in a terminal (Verified, admin-induced)
After my admin pause, chat said "ask again once someone resumes it there" and the Devices page had no Resume button.
*Change:* a Resume button on the device card when the hub is on the same machine, or at least a sentence saying how.
*Evidence:* 41-admin-device-online-paused.jpg.

### Low

#### L1 — The first message in the first-task template is a developer's test, not a user's (Verified)
"Introduce yourself in two sentences, then save a short note about what you're good at to your memory as me/strengths.md."
*Change:* "Hi Helper! What can you help me with this week?"
*Evidence:* 46-admin-wizard-step5-first-task.jpg.

#### L2 — Time-zone dropdown has ~400 raw entries (Verified)
*Change:* "Use this device's (America/New_York)" as the default, type-to-search for the rest.
*Evidence:* 32-settings-profile.jpg.

#### L3 — Tasks page says "Lead: Helper" and "Start a task and Helper plans it and hands the pieces out" for a one-agent workspace (Verified)
*Change:* hide team/lead language until there is more than one agent.
*Evidence:* 19-tasks-empty.jpg.

#### L4 — Routine step hint is written for screen automation (Verified)
"Name buttons and fields by their labels, say what changes each time, and what done looks like." For "remind me to put the bins out" this is baffling.
*Change:* "Describe what Helper should do, in your own words."
*Evidence:* 27-write-routine-dialog.jpg.

#### L5 — README's unsigned-app note reads like a warning (Verified, docs)
"The preview isn't signed by Apple yet, so the first time, right-click Warren and choose Open." A beginner reading "isn't signed by Apple" may not proceed.
*Change:* one reassuring sentence with a screenshot of the exact dialog and what to click.

---

## 6. What already worked

- Account creation is short and clear ("You'll be the owner of this workspace").
- The app itself is visually calm, consistent, and reads well; dark and light mode both fine (light mode verified after a brief transition).
- **About you**: adding a preference is a one-line form; it is listed with author and time, with pin/edit/delete.
- **Search (⌘K)** found the preference immediately.
- **Write a routine** with a weekly schedule took under a minute; the saved card shows "next Mon 9:00 AM" and has Run now and an On/Off switch in Schedule.
- **Background** has an honest on/off toggle, a daily cap, quiet hours, and says it writes only when needed.
- Agent avatars, the "👀 1" reaction when the agent picks up a message, and the "thinking" indicator give a sense of life once a device is online.
- Permissions page explains Read only / Can edit files / Full access in plain sentences with a recommended default.
- The Gmail dialog's warning about third-party servers is the right instinct (it just lacks help deciding).
- Phone layout is good: bottom tab bar, readable text, no horizontal scrolling.
- Wizard steps 2–5 (once a device is online) are short and friendly; the "Apple's container is running and the VM image is ready" check is a nice readiness signal.

---

## 7. Recommended first-use path

1. **Download page / README top:** "Warren is a free app that gives you an AI helper (and later, several) that can chat, remember things about you, and work in your apps. You need a Mac and an account with an AI service such as Claude. Download → open → follow three steps."
2. **Install:** signed DMG; first launch opens straight into "Create your account".
3. **Step 1 — Your AI service:** "Which AI do you use?" (2–3 options with cost/account note; "I don't have one yet" explains how to get one). Sign in happens in a window, not a terminal.
4. **Step 2 — Your helper:** name, look, "What should it help you with?" (home-friendly presets). Device = this Mac, chosen silently.
5. **Step 3 — Try it:** a pre-filled "Hi! What can you help me with this week?" that must get a real reply before the wizard says Done. If anything is missing, the wizard shows exactly one next action.
6. **After that:** Dashboard shows "Helper is ready" and three suggestions (plan meals, write a note, remember something). Advanced pages (Devices, Computers, Teams, Connectors catalogue, Agent runtimes) live under "More".
7. **Any time setup is incomplete:** a banner with "Continue setup", and queued messages carry a Cancel button.

---

## 8. Compared with the earlier audit (read only after testing)

The earlier `USABILITY_IMPROVEMENTS.md` (same date, same persona) reached the same verdict. Independently reproduced here: Terminal barrier in wizard step 1 (U05 ↔ C1); offline agent accepting work (U08 ↔ C2); harness choice (U07 ↔ C3); internal `task_update` text under the user's name (U10 ↔ H2); queued status with no recovery path and "node" wording (U11 ↔ C2/H6); channel messages not routed (U12 ↔ H1); Skip setup losing the way back (U06 ↔ H3); third-party/"official" connector trust (U17/U18 ↔ H4); background spending in jargon (U26 ↔ M7); time zone unset while scheduling uses local time (U34 ↔ H7); search exposing storage paths (U37 ↔ M2); Obsidian promotion (U14 ↔ M3).

New or sharper in this test: the disabled "Waiting" Continue button and non-clickable progress bar; the DM footer staying "offline" after the device came online; the Background page counting "1 of 24 checks" and a run titled "—" within seconds of toggling; the paid-account requirement surfacing only in wizard step 4 via a `claude` / `/login` command; wizard step 5's developer-flavoured first task (`me/strengths.md`); raw `people/usr_…` folder in Background "What it can see"; the Devices "Paused at the device" state with no in-app resume; the routine trash icon giving no feedback (unverified); the all-work Skills shop; the one-agent Tasks page talking about a "Lead". I did not test the DMG, desktop Create/Join screens, note creation in Memory, skill installation, or data export, all of which the earlier audit covered.
