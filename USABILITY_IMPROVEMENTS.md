# Warren usability improvements

**Audit date:** October 17, 2026  
**Perspective:** Martin, a simulated 42-year-old man with very limited technical knowledge and little experience with AI.  
**Product:** [Warren repository](https://github.com/eireijie/warren) and its Mac application.  
**Verdict:** Warren is not yet independently approachable for this beginner. The interface contains useful everyday features, but getting a working assistant requires understanding too much of the infrastructure behind them. A user can create something that looks ready, submit work, and then be left with a queue they do not know how to resolve.

## What this assessment means

This was a hands-on, simulated beginner walkthrough, not a study with a recruited human participant. Age and gender did not determine the findings; limited technical knowledge and unfamiliarity with AI did. First-person reactions below describe the requested persona, not statements collected from another person. No SUS score, population success rate, or measured time-to-completion is claimed.

I used visible screens, controls, error messages, and user-facing installation documentation to understand the product. I did not read application implementation code to discover how a feature worked, and I did not modify application source code.

There were two distinct testing tracks:

- **Beginner journey:** attempt tasks using the interface; treat unexplained technical prerequisites as obstacles rather than solve them invisibly.
- **Test administration:** launch an isolated local copy so the remaining interface could be explored without changing the user's existing workspace. This required technical assistance and is **not** counted as a successful beginner installation.

The browser build was the existing checkout at commit `f8d3d233a9d9668c8fb26d104e3c1a9d46cb7c2b`; Settings → Updates & about also displayed `f8d3d23`. The package version was `0.0.1`. I downloaded and opened the `desktop-v0.0.1` Apple Silicon DMG and inspected the already installed `/Applications/Warren.app`. I did not establish that this installed desktop binary was identical to the browser build or newly downloaded asset.

The repository is private. The initial GitHub access problem was resolved by the user's sign-in and is **excluded** from the product findings. The README does contain a prominent Mac download link; Warren is **not** being criticized for offering only a command-line installation.

### Overall beginner-friendliness

| Dimension | Assessment | Basis |
|---|---|---|
| Understanding what Warren does | Weak | The early experience emphasizes agents, servers, devices, and workspaces before showing an ordinary useful result. |
| Installation and setup | Major barrier; desktop completion unverified | A DMG exists, but desktop setup uses server concepts. The tested web onboarding requires Terminal commands to connect a device. |
| First successful AI task | Blocked in this journey | Dinner-planning work was accepted but remained queued for an offline device. |
| Navigation | Learnable with substantial exploration | Many parallel destinations and overlapping concepts; settings are hidden behind the profile menu on desktop. |
| Basic notes and preferences | Usable with friction | Saving a note and personal preference worked. Note creation, Markdown, and Obsidian messaging add unnecessary steps. |
| Automation | Easy to configure superficially; hard to trust | Weekly scheduling and pausing worked, but a queued routine was described as having run. Costs and readiness are unclear. |
| Error recovery | Weak | Offline messages identify a condition without a sufficiently direct repair path. |
| Narrow-screen use | Basic layouts worked; discovery worsened | Chat and notes reflowed, but many capabilities moved under “You,” and note actions became icons. |

## Evidence and test boundaries

**Verified** means I personally observed the described screen or behavior in this audit. The explanation of its likely effect on a beginner is a usability judgment. **Potential / untested** means the behavior was not executed or could not be established; these concerns are explicitly labeled and are not presented as reproduced failures.

### Environment and actions

- macOS; native Warren and Finder; Codex in-app browser.
- Browser walkthrough at 1280 × 900, with a 390 × 844 narrow-screen check. The temporary viewport override was reset afterward.
- Separate local hub at `http://127.0.0.1:4837`, using `/tmp/warren-usability-20261017` and its `vault` subfolder. These temporary locations were chosen for testing and are not a criticism of Warren's normal storage location.
- Synthetic account `Martin Test`, workspace `Everyday tasks — usability test`, email `martin@example.test`.
- Created an offline device entry `my-mac` and an agent `Everyday Helper`; did not connect an AI provider or grant access to real mail, files, or calendars.
- Created a dinner task, a note, a preference, an installed skill, and a weekly routine. Tested Run now, then paused the routine. Background activity was briefly enabled and then disabled.
- The existing desktop workspace was only inspected. Its previous conversations are not counted as newly reproduced results.

### Important limits

The DMG mounted and displayed the drag-to-Applications interface. I did not overwrite the existing app, complete a clean-machine installation, or reproduce a first-launch Gatekeeper block. Desktop Create/Join screens were inspected, and the Join connection test reached the local hub successfully; final desktop server creation/device registration was not completed.

The test device remained offline after the beginner reached the Terminal instructions. Therefore AI response quality, successful provider sign-in, live computer control, approvals during actual execution, multi-agent collaboration, scheduled execution, connector authorization, and recovery after reconnection were **not verified**. This is a meaningful first-use stopping point, but it does not prove these features fail after correct setup.

No real external messages, purchases, account invitations, or cloud computers were created. File attachment controls were inspected but upload and AI file analysis were not tested. Data export controls were inspected; export completeness and restoration were not tested. This is broad interface coverage, not a claim to have executed every possible state or feature.

Accessibility observations use screenshots and the exposed browser accessibility structure. Search's Escape dismissal was tested. A full keyboard journey, screen-reader audit, contrast measurement, zoom audit, touch-device test, and WCAG conformance assessment were not performed.

## Numbered walkthrough and task outcomes

These steps group the audit into understandable journeys; they are not a timing log.

| Step | Goal and actions | Observed result | Health |
|---|---|---|---|
| 1 | Find a download, open DMG, inspect desktop Create/Join and test a server address | Download and installer reached; connection test worked; clean install and final server creation unverified | Partial |
| 2 | Create a fresh account and determine what to do next | Account created; empty dashboard and numerous choices; Get started available | Weak |
| 3 | Follow onboarding, add a device, create a helper | Terminal connection instructions blocked independent progress; helper could still be created | Blocked |
| 4 | Ask for three dinners/shopping list; inspect task; ask for a thank-you note in general chat | Dinner request queued offline; technical text surfaced; channel question had no routing/status acknowledgment | Blocked / unclear |
| 5 | Save meal preferences, inspect sharing/history, add an “everyday language” preference | Note and preference persisted; audience and editing concepts required interpretation | Usable with friction |
| 6 | Find Gmail integration; inspect Computers, Devices, Teams, and setup choices | Options discoverable but highly technical; no external connection or running team completed | Weak |
| 7 | Install a meeting-summary skill; write, schedule, run, and pause a dinner routine | Skill installation and schedule/pause worked; routine execution queued | Partial |
| 8 | Inspect Model, Permissions, Soul, Instructions, Device, Computer, Connect, Runs, Look, and Background | Broad controls found; distinctions, readiness, costs, and execution history difficult to interpret | Weak |
| 9 | Review every settings category, including account, notifications, voice, people, memory, backup, updates, and approvals | Settings readable individually; important defaults hidden and backup/recovery technical | Mixed |
| 10 | Search for dinner information; open saved note; test narrow layouts and Escape | Search found saved content; note readable on narrow screen; feature locations changed | Mostly functional; discovery friction |

### Realistic scenario results

| Ordinary intention | Completion result |
|---|---|
| “Help me plan three easy dinners for two and make a shopping list.” | Submitted, but no usable answer; queued for offline helper. |
| “Help me write a polite thank-you note to a neighbor.” | Sent in general channel; no agent response verified. Both addressing rules and offline state matter. |
| “Remember that I cook for two and prefer quick meals.” | Saved manually in Memory and later found via Search. AI use of that memory was not verified. |
| “Explain things without technical language.” | Preference saved and visible after leaving and returning. AI adherence was not verified. |
| “Do my dinner planning every Monday morning.” | Weekly schedule saved; Run now queued; routine subsequently paused. Actual scheduled delivery unverified. |
| “Let the helper work with my Gmail.” | Reached search results and custom connection form; did not reach an understandable, verified end-to-end connection. |
| “Find something I saved earlier.” | Search returned Dinner preferences and opened the correct note. |
| “Stop automatic activity.” | Routine changed to Paused; Background returned to Off. Cancellation of already queued runs was not established. |

## Priorities

Severity is based on impact on this beginner journey, not engineering complexity or security exploitability.

- **Critical:** prevents the first meaningful result or permits a convincing but unusable setup.
- **High:** likely abandonment, substantial misunderstanding, or loss of confidence/control.
- **Medium:** repeated friction, discoverability problems, or an avoidable need for instruction.
- **Low:** localized clarity or presentation improvement.

| Priority | Findings | Recommended delivery order |
|---|---|---|
| **Critical** | U05, U08 | One guided path to a ready helper; truthful readiness checks before accepting work. |
| **High** | U03, U04, U07, U09, U10, U11, U15, U17, U18, U19, U24, U26, U29, U33, U34 | Fix blocked-work recovery and modal behavior; explain provider choice; simplify trust, permissions, schedules, and recovery. |
| **Medium** | U01, U06, U12, U13, U14, U16, U20, U21, U22, U23, U25, U27, U28, U30, U31, U32, U35, U36, U40 | Consolidate navigation; make everyday workflows and advanced options distinguishable. |
| **Low** | U02, U37, U38, U39 | Align installation copy and improve labels, search presentation, and visual controls. |

## Detailed findings

### Step 1 — Download, installation, and desktop entry

#### U01 — Medium — The download assumes knowledge of Mac hardware and installer conventions

**Verified.** Opened the repository's Mac download link, expanded release assets, downloaded the Apple Silicon DMG, and opened it in Finder. The installer shows Warren, an arrow, and Applications. Other desktop platforms were not available in the inspected release.

**Beginner difficulty:** “Is my Mac Apple Silicon? Do I click the arrow, double-click Warren, or move it?” A person unfamiliar with DMGs has to infer the installation gesture. Compatibility labels alone do not answer how to check their computer.

**Change:** Put “1. Drag Warren into Applications. 2. Open Applications and double-click Warren” inside the installer. Beside the download, provide a short compatibility checker or “Apple menu → About This Mac; look for Chip.” Explain unsupported platforms before download. Preserve the prominent download link.

**Evidence:** [Installer](/Users/yugpatel/kodi/usability-evidence/37-installer.png), [repository download](/Users/yugpatel/kodi/usability-evidence/04-repository-download.png). Copying the app and first launch were not completed.

#### U02 — Low — First-launch instructions differ between the README and release notes

**Verified documentation inconsistency; actual Gatekeeper behavior untested.** Compared the README's right-click/Open advice with release instructions that direct current macOS users to Privacy & Security → Open Anyway and distinguish older versions.

**Beginner difficulty:** When a security warning appears, conflicting instructions make the product seem unreliable and leave the user unsure which action applies.

**Change:** Maintain one version-aware installation guide linked from both places, with screenshots and the expected warning. Explain preview signing status plainly. A signed and notarized release would remove this detour, but its absence was established from release documentation, not a fresh Gatekeeper test.

**Evidence:** [README](https://github.com/eireijie/warren#readme), [releases](https://github.com/eireijie/warren/releases).

#### U03 — High — Desktop setup asks an infrastructure question before a personal goal

**Verified.** Opened desktop setup and inspected Create server and Join server. The welcome screen gives these choices comparable prominence and references server/network concepts. The next Create screen does usefully explain local storage, menu-bar operation, and device registration. A Join address test succeeded.

**Beginner difficulty:** “I just want help. Am I supposed to own a server?” “Register this computer as a device” makes one physical Mac sound like two separate things.

**Change:** Lead with **Use Warren on this Mac — recommended** and **Join someone else's Warren**. Explain server only under an optional technical-details disclosure. Replace registration copy with “Allow your helper to run on this Mac,” followed by what permissions come next and what happens when the Mac sleeps.

**Evidence:** [Server choice](/Users/yugpatel/kodi/usability-evidence/38-desktop-server-choice.png), [Create server](/Users/yugpatel/kodi/usability-evidence/39-desktop-create-server.png). Final creation was not exercised.

### Steps 2–3 — Orientation, setup, and first helper

#### U04 — High — The first screen and dashboard do not establish a useful everyday starting point

**Verified.** Created the fresh account, then arrived at a dashboard with many destinations and a separate Get started checklist. The account form explains ownership but does not first show a concrete everyday outcome. The sidebar exposes Tasks, Memory, Computers, Devices, Agents, Teams, Connectors, Skills, and About you.

**Beginner difficulty:** “What can I actually ask this to do, and which of all these things must I set up?” Most choices describe mechanisms rather than user goals.

**Change:** Put a short explanation and three examples before setup: write a message, plan meals, summarize a document. After account creation, continue directly into “Make your first helper ready,” with one primary action. Keep the dashboard focused on the next unfinished requirement until a first reply succeeds. Explain why an email/password is needed for this local or shared workspace and where account recovery is available.

**Evidence:** [Fresh setup](/Users/yugpatel/kodi/usability-evidence/03-fresh-setup.png), [empty dashboard](/Users/yugpatel/kodi/usability-evidence/05-empty-dashboard.png).

#### U05 — Critical — Web onboarding reaches a Terminal barrier before delivering value

**Verified, web route.** Opened Get started → Device, named `my-mac`, and continued. The next screen supplied installer/connection commands, discussed dependencies and tokens, and waited for a device connection. A second command was needed for persistent operation; the simple running process ends when its terminal closes.

**Beginner difficulty:** “What is Terminal? Where do I paste this? Why must a window stay open?” References to Git, Node, Homebrew, VM engines, tokens, and services require outside assistance. I stopped here in character.

**Change:** Detect whether Warren desktop is present and offer **Connect this Mac** with an app handoff. Otherwise offer **Download Warren for this computer** and resume the same setup afterward. Show automatic checks, progress, and a single repair action. Put remote/manual installation behind Advanced. Explain sleep, startup, and offline behavior in normal language.

**Acceptance:** A new user can connect the current supported Mac and reach a test reply without opening Terminal or understanding tokens.

**Evidence:** [Get started](/Users/yugpatel/kodi/usability-evidence/06-get-started.png); the command screen was observed, but its token-bearing area is intentionally not included in the report. Desktop auto-registration may avoid this web barrier; that completion was not verified.

#### U06 — Medium — Skipping setup removes the most obvious way back

**Verified.** Chose Skip setup. The desktop sidebar checklist disappeared. A setup link could later be found in the general-channel empty state; the narrow-screen You page also exposed Get started with progress.

**Beginner difficulty:** “I skipped because I was stuck, not because I finished.” An incomplete configuration becomes less visible precisely when help is needed.

**Change:** Keep a dismissible but recoverable **Finish setup — your helper is not ready yet** card on the dashboard. Use **Do this later** instead of language that suggests setup can be safely abandoned. Keep an always-available setup entry in Settings and Help.

**Evidence:** [Dashboard](/Users/yugpatel/kodi/usability-evidence/05-empty-dashboard.png), [general channel](/Users/yugpatel/kodi/usability-evidence/15-general.png), [You page](/Users/yugpatel/kodi/usability-evidence/85-narrow-you.png). This is a discoverability issue, not a claim that setup cannot be reopened.

#### U07 — High — Choosing a “harness” requires product knowledge the user does not have

**Verified.** Created Everyday Helper. After its name, Warren offered approximately a dozen choices including Claude Code, Codex, Hermes, Gemini CLI, OpenCode, Goose, Kimi CLI, Qwen Code, Cursor, OpenClaw, Grok, and Custom. Settings calls these agent runtimes/harnesses.

**Beginner difficulty:** “Which one writes a shopping list? Is this included? Does a subscription I already have count?” Vendor names and coding-oriented descriptions do not explain suitability, sign-in requirements, or expected charges.

**Change:** Ask “Which AI service do you use?” with a recommended supported route and **I'm not sure**. Show account requirements, a clear cost explanation, and what will be installed before asking the user to choose. Rename the beginner-facing concept **AI service** or **Assistant engine**, with technically precise details in Advanced. Do not imply every ChatGPT or other subscription automatically covers an API or coding tool.

**Evidence:** [Harness selection](/Users/yugpatel/kodi/usability-evidence/10-harness-selection.png), [runtimes](/Users/yugpatel/kodi/usability-evidence/66-runtimes.png).

#### U08 — Critical — An incomplete helper can look configured and accept work

**Verified.** Selected the offline `my-mac`, left Computer at Choose later, created the helper, and submitted the dinner task. Creation succeeded even though the device was not connected. Later messages queued rather than producing a result.

**Beginner difficulty:** “The app let me finish, so I assume it is ready.” Successful object creation is being mistaken for operational readiness. The relationship among device connection, AI installation/sign-in, and optional computer control is not made clear enough.

**Change:** Give each helper a visible readiness checklist: computer connected; AI service installed and signed in; test message succeeded; optional app-control access configured. Label unfinished helpers **Setup incomplete**. Let users save drafts, but make the primary action **Finish setup** until ready. If accepting offline work, explicitly offer **Save for later** with a warning and cancellation control.

**Acceptance:** A disconnected helper cannot appear ready; the first real task is preceded by a successful test response. Optional screen control must not be presented as mandatory for a simple text task.

**Evidence:** [Agent workspace](/Users/yugpatel/kodi/usability-evidence/11-agent-workspace.png), [offline task](/Users/yugpatel/kodi/usability-evidence/12-task-offline-feedback.png).

#### U09 — High — “Add an agent” leaves the blocking task dialog open

**Verified interaction defect.** With no agents, opened New task. Its helpful empty state offered Add an agent. Clicking that changed the page behind the dialog to Agents, while the New task dialog remained in front. I had to close the dialog before continuing with agent creation.

**Beginner difficulty:** The requested next step appears not to work; the useful destination is obscured. A novice is likely to click again or abandon the flow.

**Change:** Close or replace the task dialog when opening agent creation. Preserve the unfinished task and return to it after setup. Move keyboard focus to the agent form and use the correct dialog title.

**Acceptance:** One click on Add an agent opens an unobstructed creation flow; completing it returns to the task without losing input.

**Evidence:** [No-agent task state](/Users/yugpatel/kodi/usability-evidence/08-new-task-no-agent.png), [obscured Agents page](/Users/yugpatel/kodi/usability-evidence/09-task-dialog-obscures-agents.png).

### Step 4 — Asking for help and following progress

#### U10 — High — A normal task becomes a technical message attributed to the user

**Verified.** Submitted “Plan three easy dinners for two people and make a shopping list.” The resulting conversation included an internal task identifier and instructions mentioning the `task_update` tool and `status done`. This appeared within a message attributed to Martin Test; the task also opened a thread view.

**Beginner difficulty:** “I didn't write that. Am I meant to understand or edit it?” Internal instructions distract from the request and weaken trust in what the app is doing on the user's behalf.

**Change:** Render a plain task card with the user's exact request, assigned helper, status, and controls. Keep system-generated execution instructions out of the user-authored message body. Put identifiers and diagnostics under a technical-details disclosure.

**Evidence:** [Task conversation](/Users/yugpatel/kodi/usability-evidence/12-task-offline-feedback.png), [captured conversation text](/Users/yugpatel/kodi/usability-evidence/52-routine-run.txt).

#### U11 — High — Queued work has inconsistent status and no obvious recovery route

**Verified in the tested task/chat views.** The conversation said the request was queued until its “node reconnects.” The Tasks view grouped the task under In progress while its badge said To do. Opening the card led back to conversation/thread views. I did not find an obvious repair, edit, or cancel control in those paths.

**Beginner difficulty:** “Is it working, waiting, or broken? Which computer should I open? How do I stop it?” “Node” is another name for something already called a device.

**Change:** Use one status model everywhere: **Waiting for my-mac**, **Working**, **Needs your help**, **Done**, **Stopped**, **Failed**. Show what is blocking progress and a **Reconnect my-mac** action. Put Edit request and Cancel beside the queued task. Explain whether it may execute later when the computer reconnects.

**Acceptance:** The board, chat, and run history agree; a beginner can identify the blocker and stop pending work without opening settings.

**Evidence:** [Task board](/Users/yugpatel/kodi/usability-evidence/13-task-board.png), [task details](/Users/yugpatel/kodi/usability-evidence/14-task-details.txt), [offline notice](/Users/yugpatel/kodi/usability-evidence/12-task-offline-feedback.png). Absence from these views does not establish that cancellation is impossible elsewhere.

#### U12 — Medium — Channel messages do not clearly tell beginners whether a helper was addressed

**Verified feedback gap; response causality unverified.** Sent “Can you help me write a polite thank-you note to a neighbor?” in general without an @mention. It appeared as a normal message without a routing acknowledgment. The channel's initial guidance does mention @mentions, and the Add menu provides a mention picker. Direct-message guidance is clearer.

**Beginner difficulty:** Users familiar with basic chatbots expect a question typed into the app to reach an assistant. A remembered rule about @mentions is easy to miss.

**Change:** Display **Send to: Everyone / Everyday Helper** near the composer, or offer a visible Ask a helper button. If no helper is addressed, explain that the message was posted to the channel. If the selected helper is offline, show that before send.

**Evidence:** [General](/Users/yugpatel/kodi/usability-evidence/15-general.png), [message](/Users/yugpatel/kodi/usability-evidence/16-message-without-mention.txt), [mention picker](/Users/yugpatel/kodi/usability-evidence/18-mention-picker.txt). The offline helper is a confounding factor; lack of an answer cannot be attributed solely to the missing mention.

### Step 5 — Notes, memory, and personal preferences

#### U13 — Medium — Creating a note does not immediately let me write the note

**Verified.** Memory → New note asked for folder and name. Creating it opened an essentially empty titled note. I then had to choose Edit, work with Markdown text, and Save. Saving and later reading the dinner preferences succeeded.

**Beginner difficulty:** “I clicked New note because I wanted to type my information.” The extra create-then-edit step looks like a missing editor, and Markdown punctuation is unnecessary for a short note.

**Change:** Open a title-and-body editor immediately, with a readable formatting toolbar and a clear Save state. Default to a personal location with an explicit audience selector. Offer Markdown as an optional advanced mode.

**Evidence:** [New note](/Users/yugpatel/kodi/usability-evidence/20-new-note.png), [editor](/Users/yugpatel/kodi/usability-evidence/22-edit-note.png), [saved note found later](/Users/yugpatel/kodi/usability-evidence/82-found-note.txt).

#### U14 — Medium — Memory promotes another application before making its own editor feel sufficient

**Verified.** The Memory landing and Memory settings recommend Obsidian. Settings explain vaults, Git installation, tokens, cloning, plugins, sync intervals, and merge conflicts for use on another computer.

**Beginner difficulty:** “Do I need to install another program just to remember dinner preferences?” The user must distinguish optional power-user integration from basic functionality.

**Change:** Lead with Warren's own reading/editing workflow. Label Obsidian and Git sync **Optional: use another notes app** in Advanced. Provide ordinary cross-device access through Warren itself with clear sync status. If exposing conflicts, offer a readable comparison and restore interface instead of telling beginners to handle Git conflicts.

**Evidence:** [Memory landing](/Users/yugpatel/kodi/usability-evidence/19-memory.png), [Memory settings](/Users/yugpatel/kodi/usability-evidence/74-memory-settings.txt). Actual Obsidian sync and conflict handling were not tested.

#### U15 — High — Understanding who can read a note requires interpreting rule mechanics

**Verified UI complexity; no access-control failure alleged.** Created a note in Shared, then opened Who can see this note. The dialog exposed file-path/rule concepts, inherited permissions, and startup-loading behavior. Memory settings also describe defaults and folder rules.

**Beginner difficulty:** “Is this just for me, every person, every helper, or people I invite later?” A novice should not need to understand precedence and inheritance to decide where to write personal information.

**Change:** Before saving, show **Who can read this?** and **Who can change this?** with names/groups and plain summaries. Explain Shared explicitly. Keep rule precedence in Advanced. Rename startup loading to a purpose-based option such as **Always remind this helper of this note**, with a short explanation of cost/context implications.

**Acceptance:** A user can state the effective audience before saving and after changing a folder rule; the summary reflects actual effective permissions.

**Evidence:** [Sharing dialog](/Users/yugpatel/kodi/usability-evidence/23-memory-sharing.png), [Memory settings](/Users/yugpatel/kodi/usability-evidence/74-memory-settings.txt). Enforcement across roles was not tested.

#### U16 — Medium — Personal information is split across similarly plausible destinations

**Verified.** Added the plain-language preference under About you and confirmed it persisted. Profile handles name/timezone; Settings → Preferences handles interface behavior; About you has Preferences, Plans, Activity, and Details; Memory stores underlying notes.

**Beginner difficulty:** “If I want shorter answers, is that a preference, a profile setting, or memory?” The same word means different things depending on location.

**Change:** Rename Settings → Preferences to **App behavior**, and About you to **What helpers should know about you** or provide that subtitle consistently. Cross-link the relevant destinations with concrete examples. Start About you with a guided “What would you like your helper to remember?” field.

**Evidence:** [Saved preference](/Users/yugpatel/kodi/usability-evidence/80-preference-persisted.png), [app preferences](/Users/yugpatel/kodi/usability-evidence/65-preferences.png), [Profile](/Users/yugpatel/kodi/usability-evidence/89-profile-timezone.png). The About you explanation that changes apply from the next message is useful and should be retained.

### Step 6 — Connected apps, computers, and teams

#### U17 — High — “Official” connector labels can imply the wrong kind of endorsement

**Verified label ambiguity, not a determination of publisher legitimacy.** Searched Connectors for Gmail. Results included Gmail-related servers with other publisher names/domains and Official labels, while explanatory copy associated Official with the company making the app.

**Beginner difficulty:** “Does Official mean Google made this, Warren checked it, or the person who wrote this connector claims it?” Those meanings are materially different when choosing where to connect email.

**Change:** Separate **Made by Google**, **Published by [named publisher]**, and **Reviewed by Warren**. State exactly what each badge verifies. Show the service receiving access and requested permissions before connection. Do not apply an undifferentiated Official label to a third-party connector for a familiar service.

**Acceptance:** On every Gmail result, a novice can identify the publisher and whether Google endorses or operates it without inspecting a domain.

**Evidence:** [Gmail marketplace results](/Users/yugpatel/kodi/usability-evidence/28-gmail-results.png). No claim is made that any listed service is fraudulent or unauthorized.

#### U18 — High — Connecting an everyday app leads to developer-oriented choices

**Verified.** Gmail search returned many alternatives and technical metadata. The Warren-catalog search did not provide a matching built-in result in this test and led toward Add your own. That form asks about local/remote MCP servers, commands, arguments, environment variables, headers, and API keys.

**Beginner difficulty:** “I know my Gmail password; I don't know what an MCP server is.” A long list creates selection work without an understandable recommended connection.

**Change:** Provide a small, curated **Connect Gmail** flow with sign-in, plain permission review, a test, and disconnect. For unsupported services, say **Not supported yet** and provide a clear explanation. Move arbitrary MCP/API setup to **Advanced connections**. Explain separate provider charges and what data leaves Warren.

**Evidence:** [Search](/Users/yugpatel/kodi/usability-evidence/28-gmail-results.png), [custom connector](/Users/yugpatel/kodi/usability-evidence/30-custom-connector.png). OAuth and credential flows were not executed.

#### U19 — High — Offline devices are described as if their software has been checked and is missing

**Verified.** With `my-mac` offline, Add computer indicated that devices could not run VMs and directed me toward Docker. Research-team/runtime screens presented missing/not-installed or CLI-needed states, with installation actions disabled.

**Beginner difficulty:** “Do I need to install more software, or simply turn something on?” The UI cannot help the user distinguish an unavailable check from a confirmed missing prerequisite.

**Change:** Use **Can't check while my-mac is disconnected**. Preserve the last-known capability with a timestamp, if available. Lead with Reconnect, then recheck, then offer installation only when the missing prerequisite is established. Avoid presenting “unknown” as “not installed.”

**Evidence:** [Add computer](/Users/yugpatel/kodi/usability-evidence/32-add-computer.png), [Research team](/Users/yugpatel/kodi/usability-evidence/41-research-team.png), [runtimes](/Users/yugpatel/kodi/usability-evidence/66-runtimes.png). This tests the displayed diagnosis, not whether Docker was actually present on a connected agent device.

#### U20 — Medium — Computer choices require architectural and purchasing decisions too early

**Verified.** Inspected VM, own-screen, and Orgo cloud options. The forms reference Debian, Docker, CPU/RAM sizes, API keys, and existing computer identifiers. Orgo required a separate settings connection; its creation form was reachable before that connection existed.

**Beginner difficulty:** “Which option lets me do this task? Does a larger computer cost more? Can it touch my real files?” The option names do not answer the user's practical decision.

**Change:** Ask what capability is needed: **Answer questions only**, **Use apps in a separate desktop**, or **Use apps on my screen**. Recommend a path based on available hardware. Explain access, availability when the Mac sleeps, and third-party cost before configuration. Keep resource sizing automatic unless Advanced is opened. Validate a required cloud connection before offering creation.

**Evidence:** [Computers](/Users/yugpatel/kodi/usability-evidence/31-computers.png), [cloud form](/Users/yugpatel/kodi/usability-evidence/34-cloud-computer.png), [computer settings](/Users/yugpatel/kodi/usability-evidence/75-computer-settings.txt). No paid machine was created; actual provisioning failure was not tested.

#### U21 — Medium — Teams introduce delegation and developer roles before basic use is established

**Verified.** Opened Teams → New team and inspected Blank, Build, Research, and Solo + reviewer. The Research template proposed multiple roles/agents and technical configuration; other explanations referenced backend/frontend/reviewer roles and channel/folder names.

**Beginner difficulty:** “Why do I need four helpers to research something? Who do I talk to?” This increases setup and coordination demands before the user has experienced one working assistant.

**Change:** Keep Teams under Advanced until one helper works. Offer outcome templates such as **Compare three options** with a single named lead, explain what extra helpers contribute, and show cost/complexity before creation. Generate technical identifiers automatically.

**Evidence:** [New team](/Users/yugpatel/kodi/usability-evidence/40-new-team.png), [Research template](/Users/yugpatel/kodi/usability-evidence/41-research-team.png). Team execution was not tested.

### Step 7 — Skills and routines

#### U22 — Medium — Installing a skill does not clearly lead to trying it

**Verified.** Opened Skills, read the meeting-summary skill, assigned it to the helper, and installed it. The installed state was visible. The detail view exposed instruction-file/path information rather than making the next useful action obvious.

**Beginner difficulty:** “I installed it. Now where do I click to summarize a meeting?” “Shop” can also imply a purchase when no price is shown.

**Change:** Rename Shop to **Skill library** unless commerce is intended. After installation, show **Try this skill** with sample meeting notes and a prefilled request. Show which helper has it, whether that helper is ready, and a short before/after example. Keep raw instruction files in Advanced.

**Evidence:** [Skills](/Users/yugpatel/kodi/usability-evidence/42-skills.png), [installed skill](/Users/yugpatel/kodi/usability-evidence/44-installed-skill.png). Installation worked; skill execution was not verified.

#### U23 — Medium — Custom skills require writing a technical instruction document

**Verified.** Opened Create a skill. It asked for Markdown instructions, tags, and “Use when” style information, with developer-oriented examples. The exposed structure did not give the main instruction textbox a useful accessible name in the captured form.

**Beginner difficulty:** “Am I programming this? How do I know whether my instructions are good enough?” An unlabeled large text area also makes the field's purpose harder to identify with assistive technology.

**Change:** Offer a guided form: **What should your helper do?**, **When should it use this?**, **What should a good result look like?** Generate the underlying format. Provide a sample and preview/test action. Give every field a visible and programmatically associated label; keep Markdown editing optional.

**Evidence:** [Create-skill form structure](/Users/yugpatel/kodi/usability-evidence/45-create-skill.txt). A full screen-reader test and generated-skill behavior were not performed.

#### U24 — High — A queued routine is described as having run

**Verified.** Created a weekly dinner routine, selected Run now, and observed the request queue for the offline helper. Returning to routine information showed “last ran just now” despite no completed execution or result. I then paused its schedule successfully.

**Beginner difficulty:** “It says it ran; where are my dinner ideas?” Queuing, starting, and completing are different events. Conflating them makes unattended work hard to trust.

**Change:** Show **Queued**, **Started**, **Finished**, and **Failed** separately with timestamps. Link each run to its result or blocker. Use **Last requested** for enqueue time and reserve **Last completed** for a confirmed result. Warn before scheduling an unready helper and allow a test run to complete first.

**Acceptance:** An offline Run now never updates a “completed” or ambiguous “ran” label. The routine and task history agree about state.

**Evidence:** [Saved routine text](/Users/yugpatel/kodi/usability-evidence/51-saved-routine.txt), [queued run](/Users/yugpatel/kodi/usability-evidence/52-routine-run.txt), [paused routine](/Users/yugpatel/kodi/usability-evidence/54-paused-routine.png). Actual scheduler execution was not tested.

#### U25 — Medium — Routines are hard to discover and ask for blank procedural instructions

**Verified.** Found routines inside the individual agent's sections, then chose Write routine. The form offered a name and blank numbered steps. Scheduling presets were understandable, and the weekly preview included day, time, and timezone. Teach a task advertised a computer prerequisite; teaching was not executed.

**Beginner difficulty:** “I want this every Monday; why must I first find an agent setting and write numbered instructions?” The distinction between a routine, task, and skill is not self-evident.

**Change:** Offer **Repeat this task** beside a successful task, plus a global **Scheduled tasks** view. Include examples such as weekly meal ideas and a daily summary. Ask the desired result first, draft steps for review, and retain the good plain-language schedule preview. Put cron under Advanced.

**Evidence:** [Routines](/Users/yugpatel/kodi/usability-evidence/48-routines.png), [writing](/Users/yugpatel/kodi/usability-evidence/49-write-routine.png), [weekly schedule](/Users/yugpatel/kodi/usability-evidence/50-weekly-schedule.png).

### Step 8 — Helper behavior and advanced controls

#### U26 — High — Background activity lacks a simple boundary for autonomy and spending

**Verified interface behavior; actual spend untested.** Enabled Background briefly. It showed waiting for the device, an activity count, unavailable token usage, hourly cadence, a daily check limit, quiet hours, and a scope including everything the helper can reach. Some scope entries exposed internal paths. I turned it off afterward.

**Beginner difficulty:** “What will it do while I'm away? Does 24 checks mean 24 charges? Is off enough to stop already queued work?” Tokens and check counts do not answer spending or expected output.

**Change:** Before enabling, summarize allowed work, data sources, notification behavior, and which provider may charge. Prefer a narrow explicit scope. If reliable cost data is unavailable, say so and do not imply that a run limit is a monetary cap. Offer a conservative default, a recent-activity list, and **Pause all automatic work**, explaining queued work separately. Display the timezone beside quiet hours.

**Evidence:** [Background options](/Users/yugpatel/kodi/usability-evidence/47-background-options.png), [Background text](/Users/yugpatel/kodi/usability-evidence/46-background.txt). No real AI charge or autonomous task was observed.

#### U27 — Medium — Model and reasoning controls do not support an everyday decision

**Verified.** Opened Model with the device offline. Choices included Harness default, Other model, reasoning levels, and unavailable fast-mode behavior. The user must start/connect the device to discover actual models.

**Beginner difficulty:** “Is more reasoning always better? Will this be slower or more expensive? What is a harness default?” A beginner cannot evaluate these choices by their technical names.

**Change:** Keep an **Automatic — recommended** default. Explain speed, quality, and cost tradeoffs in one sentence each; offer goal-based choices only where the provider actually supports them. When offline, show “Connect my-mac to see available choices” rather than a collection of unusable controls.

**Evidence:** [Model](/Users/yugpatel/kodi/usability-evidence/55-model.png). Output differences and pricing were not tested.

#### U28 — Medium — Soul, Instructions, Skills, Routines, and memory overlap conceptually

**Verified.** Read Soul and Instructions. Soul covers personality, values, and boundaries and allows the agent to refine its own soul by default. Instructions cover the job, responsibilities, and reply-style additions. Skills and routines add other instruction surfaces, while About you supplies preferences.

**Beginner difficulty:** “Where do I say ‘be concise’? Which setting wins? Can the helper change what I asked it to be?” The metaphor “Soul” does not explain precedence or control.

**Change:** Start with a single **How this helper should work** screen: communication style, responsibilities, things to avoid, and remembered preferences. Explain precedence with a concrete example. Put file-based instruction layers in Advanced. Replace the self-edit checkbox with a plain explanation and a choice to review suggested behavior changes before applying them.

**Evidence:** [Soul](/Users/yugpatel/kodi/usability-evidence/57-soul.png), [Instructions](/Users/yugpatel/kodi/usability-evidence/58-instructions.png). Actual self-modification and conflict resolution were not tested.

#### U29 — High — Important permission and approval defaults are scattered and easy to misunderstand

**Verified defaults and explanations; enforcement untested.** Inspected agent Permissions and Settings → Agents. New agents default to editing files. The workspace settings enable ask-before categories for messages, purchases, deletion, and public posts, but the inspected defaults leave account sign-up and sharing private information unchecked. Text qualifies approvals with “when nobody asked for exactly this.” Device access, VM access, and who can ask the helper are separate concepts.

**Beginner difficulty:** “Will it ask me before uploading a file? Does Can edit files include my whole Mac? Does asking for a task waive later approvals?” The answer should not require combining several screens.

**Change:** Add an onboarding review with concrete examples of allowed and approval-required actions. Default the beginner preset to asking before external sharing and new account creation. Show effective file/app scope, not only Read/Edit/Full labels. Clearly state how an explicit request affects approval. Offer **Review first** as a comprehensible default and make current rules visible beside a running task.

**Evidence:** [Agent permissions](/Users/yugpatel/kodi/usability-evidence/56-permissions.png), [workspace defaults](/Users/yugpatel/kodi/usability-evidence/88-approval-defaults.png). This is not a claim that Warren actually leaked data or bypassed an approval.

#### U30 — Medium — Runs is a diagnostic list rather than a useful explanation of what happened

**Verified.** Opened Runs after a task, routine request, and brief Background enablement. Rows included queued states, raw/truncated request text, internal identifiers, and an uninformative entry for background work.

**Beginner difficulty:** “Which action caused this? Did anything happen, and what do I do next?” A run identifier is not a recognizable task name.

**Change:** Use readable names and action-based descriptions: **Weekly dinner ideas — waiting for my-mac**. Show who/what started it, last progress, outcome, next action, and Stop where applicable. Put raw prompts and identifiers under Details.

**Evidence:** [Runs](/Users/yugpatel/kodi/usability-evidence/62-runs.png). Live-progress accuracy was not tested.

#### U31 — Medium — Voice setup combines friendly promises with implementation vocabulary

**Verified settings content.** Opened Voice. It offers on-device speech plus optional OpenAI/ElevenLabs keys and explains separate billing. It also discusses online browser speech, HTTPS/localhost, and recognition availability in an Electron build. Individual voices are configured under each agent's Look section.

**Beginner difficulty:** “Does ‘on this device’ mean nothing goes online? Why is the voice chosen under Look? What is Electron?” The failure guidance depends on knowing the software packaging.

**Change:** Explain where audio is processed in everyday language. Offer **Test microphone**, **Test speaker**, and a plain availability result. Link directly to the helper's selected voice. Hide API-key and implementation-specific diagnostics behind Advanced unless needed. Preserve the explicit warning about third-party billing.

**Evidence:** [Voice settings text](/Users/yugpatel/kodi/usability-evidence/72-voice.txt), [Look](/Users/yugpatel/kodi/usability-evidence/63-appearance.png). Microphone permissions, recognition, audio quality, and calls were not tested.

### Step 9 — Settings, recovery, and navigation

#### U32 — Medium — Similar names and duplicated destinations increase navigation effort

**Verified.** Used the sidebar, agent-section navigation, and settings navigation. Computers and Devices coexist globally and inside helper configuration. Agents appears as a sidebar group, management destination, and settings category. Connectors differs from Connect and Settings → Connections; the latter concern agent tokens. Settings is reached through the profile menu on desktop.

**Beginner difficulty:** “I'm trying to connect Gmail, so should I use Connect, Connections, or Connectors?” The user is forced to learn an internal taxonomy through trial and error.

**Change:** Use distinct labels such as **Connected apps**, **Computers running Warren**, **App-control desktops**, and **Advanced agent connections**. Add a visible Settings entry and concise destination descriptions. Consolidate basic helper setup into one guided page. Keep direct links between related pages without requiring users to infer relationships.

**Evidence:** [Settings navigation](/Users/yugpatel/kodi/usability-evidence/65-preferences.png), [agent Connect](/Users/yugpatel/kodi/usability-evidence/61-connect-agent.png), [Connections settings](/Users/yugpatel/kodi/usability-evidence/69-connections.txt), [device](/Users/yugpatel/kodi/usability-evidence/59-agent-device.png), [computer](/Users/yugpatel/kodi/usability-evidence/60-agent-computer.png).

#### U33 — High — Backup guidance assumes access to folders and technical file formats

**Verified screen; export/restore not executed.** Opened Data & export. The page says to back up a hub folder and offers memory as Markdown ZIP and conversations as JSON. It describes Git and a vault. No guided restore action was apparent in this inspected page.

**Beginner difficulty:** “Which computer is that folder on? Will downloading these two things restore my helpers and schedules? How do I read JSON?” Recoverability is unclear even if the exports are technically useful.

**Change:** Provide **Back up everything** with the contents and exclusions listed, a destination picker, and a last-successful-backup timestamp. Add a guided restore path with preview. Offer human-readable conversation export alongside JSON. Explain the difference between downloading notes and backing up a complete workspace.

**Evidence:** [Data & export](/Users/yugpatel/kodi/usability-evidence/70-data.png). No claim is made that restoration is impossible elsewhere or that either export is incomplete.

#### U34 — High — Timezone is unset even though scheduling uses local-time language

**Verified state; incorrect execution untested.** Opened Profile after creating a weekly routine. Time zone was **Not set (agents see UTC)**, while Warren could detect America/New_York and offered a button to use it. The weekly routine preview had already shown America/New_York.

**Beginner difficulty:** “If I say tomorrow morning, is that my morning?” Different time assumptions across profile, natural-language requests, and schedules can produce unexpected results without an obvious error.

**Change:** Ask the user to confirm the detected timezone during onboarding and use a consistent visible default across these surfaces. Show an example local time and the next scheduled occurrence. If timezone is missing, ask before interpreting relative deadlines or scheduling a routine.

**Acceptance:** A new user sees and confirms the timezone; profile, routine previews, and natural-language task context agree. Test daylight-saving transitions separately.

**Evidence:** [Profile default](/Users/yugpatel/kodi/usability-evidence/89-profile-timezone.png), [weekly preview](/Users/yugpatel/kodi/usability-evidence/50-weekly-schedule.png). No mis-timed execution was observed.

#### U35 — Medium — Notification choices require distinguishing two delivery systems

**Verified settings.** Opened Notifications. It separately offers Push notifications and While Warren is open; both describe browser permission. Categories are shown checked while the overall device notification state is Off.

**Beginner difficulty:** “Do checked boxes mean I will get notified? Which switch tells me my task is finished?” The distinction between channels of delivery is more prominent than the desired outcome.

**Change:** Lead with **Notify me when a task finishes or needs me** and show the effective status for this device. Explain the closed-app option below it. Preview a notification and provide a test after permission is granted. Visually distinguish selected categories from active delivery.

**Evidence:** [Notification settings](/Users/yugpatel/kodi/usability-evidence/67-notifications.txt). Browser permission and actual notification delivery were not tested.

### Step 10 — Search, small screens, and presentation

#### U36 — Medium — Narrow-screen navigation moves work features under “You”

**Verified at 390 × 844.** The bottom navigation contains Chats, Agents, Search, Memory, and You. The You page exposes Dashboard, Teams, Computers, Devices, Connectors, Skills, and Settings. Tasks/New task were not present in those inspected primary menus. Notes and chat lists did reflow successfully.

**Beginner difficulty:** “Why would computers or scheduled work be under my personal page? Where did the Tasks button go?” Learning the desktop arrangement does not transfer cleanly to the narrower view.

**Change:** Use a visible **Work** or **More** destination for workspace tools and maintain a discoverable New task action. Keep You focused on personal information. Add concise labels to note actions when room permits or an Actions menu with text. Verify task creation and tracking across breakpoints.

**Evidence:** [You page](/Users/yugpatel/kodi/usability-evidence/85-narrow-you.png), [narrow note](/Users/yugpatel/kodi/usability-evidence/86-narrow-note.png), [Chats](/Users/yugpatel/kodi/usability-evidence/87-narrow-chats.png). This was browser resizing, not a physical phone test; tasks may be reachable through further navigation.

#### U37 — Low — Search finds useful content but exposes storage details

**Verified.** Searched “dinner.” Results included the saved note, the routine, and messages. Opening Dinner preferences worked. Results also displayed Markdown markers, internal request text, and file paths with identifiers.

**Beginner difficulty:** “Is this a note, a task, or a file I should not touch?” The raw metadata competes with the familiar title.

**Change:** Keep the working global search, but show clean previews and type labels: Note, Task, Routine, Message. Replace internal paths with readable location labels. Put technical paths in optional details. Search Escape dismissal worked and should be preserved.

**Evidence:** [Search results](/Users/yugpatel/kodi/usability-evidence/81-search-results.png), [opened note text](/Users/yugpatel/kodi/usability-evidence/82-found-note.txt).

#### U38 — Low — Appearance combines an approachable visual editor with an overwhelming voice list

**Verified.** Opened Look. Ghost shape, colors, eyes, mood previews, and motion controls are visually understandable. Voice choices form a long mixed-language list with implementation-style naming.

**Beginner difficulty:** “I only want a friendly English voice. Which of these do I choose?” The amount of choice is disproportionate to the simple preference.

**Change:** Default to the user's language, offer a short recommended list with Listen buttons, and add searchable language/accent filters. Move voice selection to a clearly labeled Voice subsection or link it from voice settings. Keep the visual previews and motion controls.

**Evidence:** [Look](/Users/yugpatel/kodi/usability-evidence/63-appearance.png). Voice previews/playback were not exercised.

#### U39 — Low — Dense muted text and icon-only actions add avoidable recognition work

**Verified visual characteristics; accessibility impact is a risk requiring further testing.** Dark-theme screens use small, muted secondary copy. Note actions for history, authorship, sharing, and deletion are icons; narrow layouts remove additional text labels. Many controls do expose accessible names, which is helpful.

**Beginner difficulty:** A person can see that buttons exist but still not know what they mean. Important setup or cost explanations are easy to skim past when visually subordinate.

**Change:** Give important actions visible text, especially Share, History, Edit, and Delete. Increase the prominence of prerequisites and blocking states. Retain the existing Large text and Reduce motion settings, but make them easy to discover early. Measure contrast and target sizes rather than assuming the current design passes or fails.

**Evidence:** [Note editor](/Users/yugpatel/kodi/usability-evidence/22-edit-note.png), [narrow note](/Users/yugpatel/kodi/usability-evidence/86-narrow-note.png), [appearance settings](/Users/yugpatel/kodi/usability-evidence/78-theme.txt). No numeric contrast or WCAG violation is asserted.

#### U40 — Medium — There is no obvious beginner help destination in the main navigation inspected

**Verified discoverability limitation.** Looked through the main sidebar, user menu, and every settings category for an ordinary recovery route. Updates & about links to GitHub for issues and contributions. Individual pages contain explanations, but no prominent Help / What can I do? destination appeared in these paths.

**Beginner difficulty:** “When I get stuck, am I supposed to file a GitHub issue?” An assistant that is not yet connected cannot reliably be the only source of setup help.

**Change:** Add Help with **Finish setup**, **My helper isn't answering**, **What can Warren do?**, a plain-language glossary, and contact/report-problem options. Troubleshooting should show current readiness and provide repair actions. Offer an optional diagnostic summary that the user can review before sharing.

**Evidence:** [Empty dashboard](/Users/yugpatel/kodi/usability-evidence/05-empty-dashboard.png), [settings](/Users/yugpatel/kodi/usability-evidence/65-preferences.png), [Updates & about text](/Users/yugpatel/kodi/usability-evidence/71-updates.txt). This does not prove help is absent from every unvisited menu or external document.

## Recommended beginner experience

### A first-use path that leads to one real success

1. **Explain the benefit:** “Warren helps you write, plan, and complete tasks. Start with one helper.” Show a meal plan, polite message, and document summary as examples.
2. **Choose a goal:** Ask what the user wants to try first; preserve that choice through setup.
3. **Connect this computer:** Prefer the desktop handoff and automatic readiness checks. Keep remote servers and manual commands optional.
4. **Connect an AI service:** Explain account requirements and charges in ordinary language; provide a recommended route and a successful connection test.
5. **Review boundaries:** State what the helper can read/change and which actions require approval. Confirm timezone.
6. **Try the chosen task:** Use synthetic example content if the user wants a safe demonstration. Show waiting/working/completed states accurately.
7. **Reveal more only when useful:** Offer Remember this, Repeat this, or Connect an app after the user has seen a result.

A demonstration mode with clearly labeled example results would let someone learn the interface before connecting accounts. It must not imply that a real task has run.

### Navigation and terminology proposals

These are proposed beginner-facing labels, not claims that all underlying technical concepts are interchangeable.

| Current term | Proposed beginner presentation |
|---|---|
| Agent / ghost | Helper; explain the ghost as its visual character |
| Harness / runtime | Assistant engine or AI service, with Advanced technical details |
| Server / hub | Your Warren workspace; explain where it runs when relevant |
| Node / device | Computer running Warren; use one consistent term |
| Computer / VM / own screen | Desktop the helper can use; explain separate desktop versus your screen |
| Connectors | Connected apps |
| Agent Connect / Connections | Advanced agent connections |
| Soul | Personality and boundaries |
| Instructions | Job and responsibilities |
| Skills / Shop | Skills / Skill library, with “Try this” examples |
| Routines | Scheduled tasks or Saved routines, with a plain distinction from skills |
| Runs | Activity and results |
| Headless | No screen needed — answers and file-based work only, if accurate for that engine |
| Token / API key | Explain its purpose at the point of need; never assume it means an ordinary password |
| Full access / sandbox | Describe the actual files, commands, and environment the helper can affect |

Suggested primary navigation: **Home, Ask a helper, Tasks, Notes & preferences, Connected apps, Settings & Help**. Teams, arbitrary runtimes, connection tokens, VM resource tuning, and raw instruction files can remain available under Advanced. This should be a progressive interface, not removal of power-user features.

### Additional useful features

- A readiness card with one-click recovery and a **Send test message** action.
- A universal **Pause automatic work** control that distinguishes schedules, active work, and queued work.
- A task detail view with readable progress, results, edit/cancel, and a record of approvals.
- A plain-language capability checklist: “Can answer questions,” “Can read selected documents,” “Can use Gmail,” with setup links.
- A small library of everyday templates: meal planning, shopping lists, polite messages, trip checklists, document summaries, and recurring household planning.
- A **Why am I seeing this?** explanation for technical choices and unavailable controls.
- A permissions summary expressed as people, apps, and folders, including clear review of external sharing.
- A spending/usage summary that separates Warren's price from AI-provider and cloud-computer charges; do not show invented cost estimates when data is unavailable.
- Full-workspace backup/restore plus readable exports.
- A beginner mode that can be left later without losing work or changing the user's setup.

## What already worked and should be retained

The account form was short. Download discovery was straightforward after GitHub access. The desktop connection test provided useful staged feedback. New task correctly recognized the absence of agents, even though its follow-on action had a modal bug. The DM empty state explained that no @mention is needed. Manual note saving, note history visibility, and personal preference persistence worked. Skill installation was straightforward once the concept was understood. Weekly schedule presets, a human-readable timezone preview, and pausing were useful. Global search found saved information and opened the correct note. Basic mobile reflow, theme choices, larger text, and reduced motion are valuable foundations.

These successes do not remove the setup barrier: none substitutes for helping a new user get a first successful reply.

## Follow-up validation plan

After the Critical and High fixes, recruit people with little AI/developer-tool experience. Do not explain the product before the test or rescue them from confusing labels. Ask them to:

1. Install Warren on a supported clean Mac and explain where their data is stored.
2. Get one helper ready and obtain a dinner plan without Terminal or outside documentation.
3. Explain any provider charge and what access they granted.
4. Disconnect the computer, submit a request, identify why it is waiting, and cancel it.
5. Save a private preference and correctly identify who can read it.
6. Connect a supported app and correctly identify its publisher and access scope.
7. Schedule a weekly task, identify its next run and timezone, then pause it.
8. Find a past result, export readable content, and restore a test backup.

Record completion without assistance, requests for help, wrong turns, comprehension of status/access, and confidence. Measure time only in a controlled session. Separately test provider sign-in, permissions enforcement, actual scheduled delivery, reconnection behavior, voice, export integrity, accessibility, and screen-reader/keyboard use.

## Visual evidence walkthrough

The following are the accepted illustrative screenshots, grouped by the numbered journeys. Other linked captures above provide supporting detail. Screenshots show synthetic test content unless identified as desktop setup. The native setup capture contains the computer's existing display name. Do not publish the evidence externally without reviewing it.

### 1. Installer and desktop choice

![DMG installer with Warren, arrow, and Applications](/Users/yugpatel/kodi/usability-evidence/37-installer.png)

![Desktop Create or Join server choices](/Users/yugpatel/kodi/usability-evidence/38-desktop-server-choice.png)

### 2. Fresh account and dashboard

![Fresh setup form](/Users/yugpatel/kodi/usability-evidence/03-fresh-setup.png)

![Empty dashboard and large navigation surface](/Users/yugpatel/kodi/usability-evidence/05-empty-dashboard.png)

### 3. Helper setup

![Get started device step](/Users/yugpatel/kodi/usability-evidence/06-get-started.png)

![Many harness choices](/Users/yugpatel/kodi/usability-evidence/10-harness-selection.png)

![Offline device and computer choices](/Users/yugpatel/kodi/usability-evidence/11-agent-workspace.png)

### 4. Task handoff and progress

![Task dialog remains in front of agent creation destination](/Users/yugpatel/kodi/usability-evidence/09-task-dialog-obscures-agents.png)

![Technical task instructions and offline feedback](/Users/yugpatel/kodi/usability-evidence/12-task-offline-feedback.png)

![Task board status](/Users/yugpatel/kodi/usability-evidence/13-task-board.png)

### 5. Notes and remembered preferences

![Note editing](/Users/yugpatel/kodi/usability-evidence/22-edit-note.png)

![Note-sharing controls](/Users/yugpatel/kodi/usability-evidence/23-memory-sharing.png)

![Saved everyday-language preference](/Users/yugpatel/kodi/usability-evidence/80-preference-persisted.png)

### 6. Connected apps and computer setup

![Gmail connector search results](/Users/yugpatel/kodi/usability-evidence/28-gmail-results.png)

![Custom connector form](/Users/yugpatel/kodi/usability-evidence/30-custom-connector.png)

![Adding a computer](/Users/yugpatel/kodi/usability-evidence/32-add-computer.png)

### 7. Skills and recurring work

![Installed skill](/Users/yugpatel/kodi/usability-evidence/44-installed-skill.png)

![Weekly routine schedule](/Users/yugpatel/kodi/usability-evidence/50-weekly-schedule.png)

![Routine paused after testing](/Users/yugpatel/kodi/usability-evidence/54-paused-routine.png)

### 8. Helper behavior and history

![Background activity settings](/Users/yugpatel/kodi/usability-evidence/47-background-options.png)

![Run history](/Users/yugpatel/kodi/usability-evidence/62-runs.png)

### 9. Important settings

![Default approval categories](/Users/yugpatel/kodi/usability-evidence/88-approval-defaults.png)

![Data and export controls](/Users/yugpatel/kodi/usability-evidence/70-data.png)

![Profile with timezone not set](/Users/yugpatel/kodi/usability-evidence/89-profile-timezone.png)

### 10. Search and narrow-screen use

![Search finds dinner information but shows raw metadata](/Users/yugpatel/kodi/usability-evidence/81-search-results.png)

![Narrow-screen navigation groups workspace features under You](/Users/yugpatel/kodi/usability-evidence/85-narrow-you.png)

![Saved note remains readable on a narrow screen](/Users/yugpatel/kodi/usability-evidence/86-narrow-note.png)

## Test cleanup and reproducibility

Application source was left unchanged. The report and evidence are the audit deliverables. Synthetic data remains in the isolated temporary test directory; its routine was paused and Background disabled. The local test hub was stopped after testing. The existing desktop workspace was not reconfigured, and no real connector or provider credentials were added. The downloaded DMG remains in Downloads. The temporary browser viewport override was reset.

To reproduce the browser findings, start the same checkout with a separate data/vault directory and follow the numbered journeys using a newly created account. Starting that test environment is an administrative prerequisite, not part of the claimed beginner success. Retest on the latest packaged release before treating every browser observation as a desktop-release defect.
