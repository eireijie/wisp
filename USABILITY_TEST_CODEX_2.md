# Warren usability test: Martin, complete beginner — Simple mode

**Verdict: Simple makes Warren easier to understand, but Martin still cannot reach his first useful AI answer independently.** The welcome, readiness message, Help checklist, preference entry and weekly schedule picker are real improvements. They sit around a setup process that still requires installing software, choosing an AI program and understanding which computer runs what. Martin can prepare work, but cannot confidently get it done.

Tested on 17 October 2026 at `http://localhost:5240/`, using a fresh throwaway workspace, “Martin’s home,” and `martin.beginner@example.com`. This is a simulated beginner walkthrough, not a study with a recruited participant. First-person remarks below represent Martin’s interpretation of observed screens.

## Summary

| Requested step | Outcome | Beginner assessment |
|---|---|---|
| 1. Account, welcome, Simple choice | Completed | Clear examples; Simple is an obvious choice. Account creation comes before explaining the product. |
| 2. Get started / connect computer | Blocked; used Do this later | Mac download looks friendlier, but Apple silicon/server terminology and installation prerequisites remain a barrier. No displayed commands were run. |
| 3. Home/Dashboard and Help | Read and used | Readiness and checklist explain the blocker; recovery still returns to setup/device administration. |
| 4. Create a helper | Sam created, offline | Better AI explanations and honest warning; no guided installation/sign-in or usable computer available. |
| 5. Realistic tasks, settings, search, phone | Mixed | Preferences, notes, search and routine configuration work. Dinner and thank-you output blocked. Gmail incompatible with selected helper according to its dialog. |
| 6. Switch to Advanced and compare | Completed | More choices and technical controls; also fewer explanations. Simple retained the tested everyday actions. |

**Completion means the observed action succeeded, not that its downstream AI behavior was proven.** No AI reply was generated. The saved weekly routine was not observed firing. No real account, inbox or external messaging service was connected.

## Method and evidence

Used small Node/Playwright scripts in this folder, read page text and accessibility snapshots before choosing controls, clicked visible UI, and inspected saved screenshots. No application source was modified, no installer or app-provided command was executed, and no localStorage token was read or edited. The prior audit was deliberately withheld until this independent walkthrough and findings were written.

Most desktop screenshots use 1440×1000. The first welcome screenshot uses the browser’s initial smaller viewport; the later welcome revisit shows the complete choice at desktop size. Phone testing uses a 390×844 viewport in desktop Chromium, not a physical phone or an on-screen keyboard. Each numbered screenshot has a corresponding `.txt` accessibility snapshot. The command block in `05-command-option-redacted.png` was masked before capture; screenshots do not expose a token or key.

A transient Marketplace loading capture (`31`) is excluded from conclusions; loaded results are in `32`. Long Help snapshots contain more text than is visible in one screenshot. Screen-reader behavior, measured contrast compliance, real touch behavior and all-device compatibility were not tested.

## Numbered walkthrough

### 1. Create account and read the welcome — completed

I entered a name, workspace name, made-up email and password, then clicked **Create workspace**. The eight-character password requirement was clear. “Owner” and “workspace” arrived before I knew what the app was, but I could complete the form.

The welcome explained chatting with AI helpers, work happening on a chosen computer, and remembering useful information. Dinner planning, drafting a polite message and summarizing a document were concrete enough for me to understand the point. I clicked the already recommended **Simple** choice and continued. Later Help and Settings both explicitly confirmed that Simple was active.

“I want the everyday parts, so Simple sounds right. I don’t know what harness details, VM sizes or tokens are, so the other choice feels like it is for someone else.” The promise of setting up in “the next few minutes” did not match the subsequent prerequisite work.

Evidence: [01-start.png](evidence/01-start.png), [02-welcome.png](evidence/02-welcome.png), [42-settings-simple.png](evidence/42-settings-simple.png). The end-of-test welcome revisit, with Advanced selected, shows both choices fully: [77-welcome-advanced.png](evidence/77-welcome-advanced.png).

### 2. Get started and connect a computer — blocked and postponed

The first step was **Device**, with later steps called **Its job**, **Agent**, **Harness** and **First task**. I accepted the suggested name `my-mac`. The page mentioned a home server, routers, firewalls and VMs. “I only want help deciding what to cook. I don’t understand why I need to know these things.”

The next screen offered **Easiest: download Warren for Mac**, **Download for Apple silicon**, **All releases**, and instructions to open the app and choose **Join a server** using the displayed address. This was clearly a better starting point than a command, but it did not explain how to identify my Mac, what a server is, or how I would know the installation had succeeded. The download link was inspected as a visible link; the disk image was not downloaded or installed, so its availability and installation experience remain untested.

I expanded **Connect another computer with a command**. It introduced Terminal, git, Node 22+, Homebrew, a VM engine, folders, a token and two different ways to keep Warren running. I did not copy or run the command. The persistent “Waiting for my-mac to connect…” state provided no in-page beginner alternative beyond **Do this later**, which I used.

The remaining wizard steps could not be completed under this constraint; the separate Agents flow was tested in step 4. At the end, revisiting setup in Advanced showed the saved, never-connected device with `warren node start` and a disabled Waiting button. The original Mac download instructions were no longer on that screen. This later recovery state is verified in Advanced; its identical behavior in Simple was not retested.

Evidence: [03-setup-computer.png](evidence/03-setup-computer.png), [04-connect-mac.png](evidence/04-connect-mac.png), [05-command-option-redacted.png](evidence/05-command-option-redacted.png), [73-setup-advanced.png](evidence/73-setup-advanced.png).

### 3. Home/Dashboard and Help — useful diagnosis, incomplete recovery

The screen was labeled **Dashboard**, not Home. It said **Your helper isn’t ready yet**, **Next: Connect a computer to Warren**, and offered **Continue setup**. This made the next required action clear. After Sam existed, the Simple dashboard named both Sam and my-mac, said the computer was offline, and linked to Devices. It also showed my dinner task as not started.

I opened **Help** and **My helper isn’t answering**. Initially it correctly identified that I had no helper and marked dependent checks “Can’t tell yet.” After creation, it recognized Sam and the assigned computer, then flagged the connection as needing fixing. “At least I know it isn’t thinking about my question.” The checklist updated with the workspace state and used text as well as icons.

Help explained the vocabulary, described realistic uses, and offered a way to see the welcome again. But **Fix this** was a route to setup or Devices, rather than a guided repair. I followed the later Fix this link in Advanced: Devices showed **Never connected**, role choices and **Remove device**, without a reconnect/install instruction on that screen. Help’s text “Turn on my-mac and make sure Warren is running there” assumes I know how to do that.

Evidence: [06-home.png](evidence/06-home.png), [08-help-troubleshooting.png](evidence/08-help-troubleshooting.png), [47-mobile-home.png](evidence/47-mobile-home.png), [50-mobile-help.png](evidence/50-mobile-help.png), [74-help-glossary.png](evidence/74-help-glossary.png), [75-help-fix-destination.png](evidence/75-help-fix-destination.png).

### 4. Create a helper through Agents → New agent — saved, not ready

The empty Agents page listed Claude Code, Codex, Hermes, Gemini CLI, OpenCode and Goose. I named my helper **Sam**. The friendly character helped, but “Who’s joining?”, invitations and “Discover on a connected device” suggested knowledge I did not have.

**Which AI do you use?** was substantially more helpful than a bare brand picker. It identified the companies, described account requirements and warned about separate charges. I opened **I’m not sure**. It recommended something I already pay for, or Claude Code/Codex otherwise. “I don’t already pay for one. Why are those better for me than the one that says it has a free tier?” I chose **Gemini CLI** because the card explicitly mentioned a Google account and free tier; I did not use outside knowledge of the tools.

At **Where should it work?**, the device was `my-mac (offline)`. **Its own desktop** and **My own screen** were disabled. **Decide later** was usable, so I chose it. The warning clearly said I could create Sam now but it could not answer until my-mac reconnected. “Install Gemini CLI on my-mac before its first run” offered no installation/sign-in action. I clicked **Add agent** successfully.

Sam’s overview then showed Model, “Harness default,” Device, Computer, Access, Runtime, Background, Connect and raw personality text with `##` markers. “I thought I picked Simple. This looks like a control panel, and I still haven’t spoken to Sam.”

Evidence: [09-agents-empty.png](evidence/09-agents-empty.png), [10-helper-create.png](evidence/10-helper-create.png), [11-which-ai.png](evidence/11-which-ai.png), [12-ai-guidance.png](evidence/12-ai-guidance.png), [13-where-work.png](evidence/13-where-work.png), [14-helper-created.png](evidence/14-helper-created.png).

### 5. Realistic scenarios — results

| Scenario and action | Observed outcome | Martin’s reaction / limit | Evidence |
|---|---|---|---|
| New task: “Suggest three easy dinners and a shopping list”; details for two adults, under 30 minutes | Saved as a task, opened Sam’s chat and a thread; explicitly queued while offline | “It saved my request, but I still have no dinners. Why two copies of the conversation?” Output quality cannot be tested. | [15](evidence/15-new-task.png), [16](evidence/16-dinner-task-result.png) |
| Ask general chat for a short thank-you note to a neighbour | Plain message appeared with no reply or explanatory notice. I then used the visible @mention instruction, typed `@`, selected Sam and resent | Mention picker worked; mentioned request received the offline queue notice. No thank-you draft arrived. | [17](evidence/17-general-chat.png), [18](evidence/18-general-without-mention.png), [19](evidence/19-mention-picker.png), [20](evidence/20-general-mentioned.png) |
| About you: remember a preference for dinners under 30 minutes and a short shopping list | Remember this created a Preferences entry; it remained after leaving and returning | Straightforward success. Whether an AI uses it was not testable. | [21](evidence/21-about-you.png), [22](evidence/22-preference-saved.png), [27](evidence/27-preference-persisted.png) |
| Memory: create “Saturday shopping,” write groceries and a cupboard reminder, Save | Note saved and reopened with its text intact | “The folder’s code-like name worries me, but the note itself works.” | [23](evidence/23-memory.png), [24](evidence/24-new-note.png), [25](evidence/25-note-editor.png), [28](evidence/28-note-reopened.png) |
| Connected apps: search Gmail, compare catalog/Marketplace, inspect recommended Zapier Add dialog | Catalog had no Gmail match; a recommended Zapier card explained Gmail support. Marketplace supplied many third-party results. Add dialog said Gemini was not wired for this connection | Stopped at the explicit compatibility limitation and cancelled. No OAuth/sign-in, connection or inbox access tested. | [30](evidence/30-gmail-catalog.png), [32](evidence/32-gmail-results.png), [33](evidence/33-gmail-add.png) |
| Skills: browse library and read “Write a weekly status report” | Library and Read panel opened; description explained automatic matching | Most examples were business/developer work. The reading panel still contained `memory_search`, vault paths and Markdown instructions. No skill installed or executed. | [34](evidence/34-skills.png), [35](evidence/35-skill-detail.png) |
| Sam → Routines → Write a routine | Saved “Weekly dinner ideas,” every Monday at 9 AM, America/New_York, with steps left optional | Excellent plain schedule picker. Later Schedule reopened with the same values and On checked. Actual execution and delivery were untested; Sam remained offline. | [37](evidence/37-routines.png), [38](evidence/38-new-routine.png), [39](evidence/39-weekly-schedule.png), [40](evidence/40-routine-saved.png), [65](evidence/65-schedule-advanced.png) |
| Settings → App behavior | Found through Martin’s account menu; Simple selected; message/clock settings visible | Useful distinction from About you. No visible Settings label in the main desktop sidebar; learning the account menu is necessary. | [41](evidence/41-account-menu.png), [42](evidence/42-settings-simple.png) |
| Search for Saturday, then dinners | Found and opened the saved note; dinners found the task message, preference and routine note | Strong success. No technical query syntax needed. | [43](evidence/43-search.png), [44](evidence/44-search-note.png), [45](evidence/45-search-open-note.png), [46](evidence/46-search-dinners.png) |
| Phone viewport 390×844 | Home, You, New task, Help, Memory tree/note, Chats, general chat and Settings remained usable in inspected views | No obvious horizontal clipping of these main layouts. Many note actions lose visible labels. Home/New task/Help sit under You; chat hides bottom tabs but provides Back to chats. | [47](evidence/47-mobile-home.png)–[56](evidence/56-mobile-app-behavior.png) |

### 6. Switch to Advanced once and revisit — completed

I returned to Settings → App behavior and clicked **Advanced** once. A **Saved** confirmation appeared. I left the account in Advanced after the comparison. I revisited welcome/setup, Dashboard, Help, Agents/new-helper wizard, Sam’s overview and routine schedule, New task, general chat, About you, Memory, Gmail search, Skills, Search and the phone Dashboard. The second helper wizard was cancelled; no extra helper was created.

| Surface | Simple | Advanced | Assessment |
|---|---|---|---|
| Dashboard | Readiness reason, next action, conversations and task to check | Agent/team/task counts, empty Teams section, no direct setup-repair banner | Strong visible distinction; the readiness guidance should remain available in either mode. |
| Main navigation | Teams omitted | Teams appears | Reasonable reduction for one-helper everyday use. Computers and Devices still coexist in Simple. |
| AI picker | Three explained recommendations and “I’m not sure”; more choices disclosed | Twelve names, “Choose a harness,” no account/cost explanations on this step | Simple helps; Advanced should add choices without discarding useful explanations. |
| Work location | Plain desktop/screen choices; handle and more options collapsed | Handle field and headless checkbox visible; “New VM” terminology | Hiding technical setup is sensible, but a plain “text tasks only” choice might be useful; that behavior was not tested. |
| Helper overview | Runtime, model/device/computer/access and raw personality preview | Essentially the same content | Simple has not simplified this prominent destination enough. |
| Routine schedule | Everyday presets; Custom schedule disclosed | Custom (cron) also present in the selector | Everyday weekly scheduling remains available in Simple. |
| Connected apps | Separate recommended Zapier card; “Search apps”; own-server option disclosed | “Add your own” prominent; “Search apps and MCP servers”; full Marketplace results | Better hierarchy in Simple, but compatibility and provider selection remain difficult. |
| Skills | Plain introductory explanation, “No helper has this yet,” shorter descriptions | Harness wording, “Not installed,” longer descriptions | Copy improves in Simple; the actual subject matter is still mostly work/software. |
| Memory, saved About you, New task, general chat, Search | Core save/send/find actions available | Little material difference in inspected states | No tested everyday action required switching to Advanced. |
| Settings | Technical links grouped under Advanced with explanatory text | Technical links mixed into Workspace settings | Logical distinction, though the Simple technical group remains visibly present. |
| Help | Full checklist/glossary and current-mode explanation | Same assistance, with mode label updated | Useful consistency. |

“I can see that Advanced means more settings, but I wouldn’t know why I should need them. Simple is better for me, yet it still asks me to manage a computer and an AI program.” No essential tested action was actually lost in Simple. The concern is more incomplete simplification than excessive hiding. Whether tucked-away headless operation or other provider choices are needed for particular everyday setups remains untested.

Evidence: [57-settings-advanced.png](evidence/57-settings-advanced.png), [58-home-advanced.png](evidence/58-home-advanced.png), [59-help-advanced.png](evidence/59-help-advanced.png), [61-ai-advanced.png](evidence/61-ai-advanced.png), [62-workspace-advanced.png](evidence/62-workspace-advanced.png), [63-helper-advanced.png](evidence/63-helper-advanced.png), [64-routine-advanced.png](evidence/64-routine-advanced.png), [66-new-task-advanced.png](evidence/66-new-task-advanced.png), [67-chat-advanced.png](evidence/67-chat-advanced.png), [68-about-advanced.png](evidence/68-about-advanced.png), [69-memory-advanced.png](evidence/69-memory-advanced.png), [70-gmail-advanced.png](evidence/70-gmail-advanced.png), [71-skills-advanced.png](evidence/71-skills-advanced.png), [72-search-advanced.png](evidence/72-search-advanced.png), [76-mobile-advanced-home.png](evidence/76-mobile-advanced-home.png).

## Prioritized findings

Severity describes impact on this beginner journey. **Verified** means the described UI/behavior was observed; it does not mean a technical malfunction was proven. **Potential/untested** items explicitly identify the missing evidence.

### Critical

**C1 — Verified: The first useful answer is behind expert setup.** “I signed up to get dinner ideas. Now I need another app, an AI account, a computer that stays on and something called a harness. I cannot get to the part I came for.” The flow stopped at computer connection, and both AI requests remained unanswered. **Change:** make Simple a complete guided route: identify the computer, download/open the correct app, link it automatically, install/sign into a supported AI through visible steps, then verify readiness with a first successful reply. Offer a clearly labeled demo if an immediate answer cannot be provided. **Evidence:** `03-setup-computer.png`, `04-connect-mac.png`, `05-command-option-redacted.png`, `13-where-work.png`, `16-dinner-task-result.png`.

### High

**H1 — Verified: Recovery identifies the problem but does not complete the repair journey.** “I clicked Fix this because I don’t know how to connect my Mac. I’m looking at its settings, and the other setup screen tells me to run a command.” Initial Simple Help routes back to setup; the later Advanced recovery route showed a never-connected device without a repair action, and resumed setup no longer showed the original download instructions. **Change:** distinguish Never connected from temporarily Offline; offer Resume installation / Open Warren / Retry connection directly for that device, preserving the original guidance. **Evidence:** `08-help-troubleshooting.png`, `50-mobile-help.png`, `73-setup-advanced.png`, `75-help-fix-destination.png`. Same post-skip screens in Simple were not separately retested.

**H2 — Verified: A recommended AI choice leads to an incompatible recommended app connection.** “I chose the free Google option you offered. Now Gmail says it isn’t wired for my helper. Did I choose wrong?” Gemini was one of three Simple recommendations. Zapier’s dialog checked Sam by default while saying Gemini/ACP agents were unsupported, yet still offered Connect and sign in. **Change:** show app compatibility during AI selection, filter recommendations to usable combinations, and disable unsupported assignment with a plain explanation and supported alternative. **Evidence:** `11-which-ai.png`, `12-ai-guidance.png`, `33-gmail-add.png`. Actual connection behavior was not attempted.

**H3 — Verified: General chat accepts an AI request without ensuring a recipient.** “My question is there, but nobody says whether anyone will answer.” Sending without a mention produced no explanatory status; selecting Sam produced a queue notice. The @mention instruction exists, but assumes the user knows how to apply it. **Change:** provide a visible Ask Sam control/recipient selector and a post-send “No helper was asked” action. With one helper, offer a clear default instead of relying on syntax. **Evidence:** `17-general-chat.png`, `18-general-without-mention.png`, `19-mention-picker.png`, `20-general-mentioned.png`.

**H4 — Verified: Simple is not consistent across the core helper journey.** “I picked Simple, but I’m still asked about Harness, Workspace and Runtime, and I see computer settings and code-looking text.” Wizard navigation/footer uses harness/workspace; onboarding uses VMs/routers/firewalls; the helper overview presents raw personality headings, model settings, Background and Connect. **Change:** use Helper, AI service and Work location consistently; show a short readiness card plus Ask, Remember and Routine actions first; disclose technical controls and render personality prose normally. **Evidence:** `03-setup-computer.png`, `10-helper-create.png`, `11-which-ai.png`, `14-helper-created.png`, `42-settings-simple.png`.

### Medium

**M1 — Verified: Mac instructions require hardware and hosting vocabulary.** “Is Apple silicon my Mac? Is Warren already installed because I have it open here? What is Join a server?” **Change:** use Download for this Mac with a visible compatibility explanation, illustrated install/open steps, and a link that prefills the connection address. Clearly distinguish the website from the Mac app. Keep All releases secondary to readable platform choices. **Evidence:** `04-connect-mac.png`.

**M2 — Verified: AI guidance explains brands, but leaves the actual account/install task to the user.** “Do I need to buy something first? Where do I sign into Sam?” The uncertainty help links to account websites and favors paid options while the free-tier card has no comparable guided next step. **Change:** let the user choose “I don’t have an AI account,” compare understandable costs/capabilities, and provide a visible install/sign-in/check sequence. **Evidence:** `11-which-ai.png`, `12-ai-guidance.png`, `13-where-work.png`.

**M3 — Verified: The New task form describes delegation that cannot happen with one helper.** “Who else is Sam handing pieces to? What does ‘or hand it straight to…’ mean when nothing is listed?” After sending, the message admits Sam is the only agent. **Change:** for one helper, say “Sam will do this”; omit the empty alternative and subtasks explanation; show readiness before sending; open one clear task conversation instead of both chat and thread automatically. **Evidence:** `15-new-task.png`, `16-dinner-task-result.png`, `49-mobile-new-task.png`.

**M4 — Verified: A saved routine looks operational despite the offline helper.** “It says next Monday at 9, so I expect dinner ideas then. Where will they arrive?” The saved routine shows the next occurrence and Run now, without the offline warning used in chat. **Change:** label “Schedule saved — waiting for my-mac,” explain what happens to missed runs, and show the delivery destination with a test/preview action. **Evidence:** `39-weekly-schedule.png`, `40-routine-saved.png`, `65-schedule-advanced.png`. Missed-run and delivery behavior remain untested.

**M5 — Verified: New note exposes an internal folder identifier.** “Why does my folder say `people/usr_…` rather than Martin? Will this be private?” The tree already knows the friendly name, but the create dialog does not use it. **Change:** offer friendly choices such as My notes, Shared with everyone and Sam’s notes, with a short sharing explanation; keep raw paths in Advanced. **Evidence:** `23-memory.png`, `24-new-note.png`, `28-note-reopened.png`.

**M6 — Verified: Gmail discovery requires evaluating providers and technical badges.** “I searched Gmail. Why are there so many different Gmail things, and why is something called agmail above them?” The app does explain publisher badges, which is good, but the list mixes an unrelated hourly-inbox service, third parties, MCP, npm, PyPI and sign-in/key variants. **Change:** present a supported Gmail connection first, with provider, price/account requirements and permissions in plain language; move alternative servers to Advanced and improve relevance ranking. **Evidence:** `30-gmail-catalog.png`, `32-gmail-results.png`, `33-gmail-add.png`.

**M7 — Verified: Phone Memory actions are mostly icons without visible labels.** “Which little symbol saves a new note? Is the arrow going to share it or open something?” Accessible names exist, but sighted touch users do not see them. Several note actions compete for one narrow row and the note title is truncated. **Change:** retain visible New note and Edit labels; put history, attribution, external app, permissions and Delete in a labeled More menu. **Evidence:** `51-mobile-memory.png`, `52-mobile-note.png`. Touch target sizes and screen-reader usability were not measured.

**M8 — Verified: Phone navigation relocates everyday workspace actions under You.** “I want Home or a new task. Why would I look in my profile?” Dashboard, Help, New task and Connected apps are all there. The You page’s explanatory subtitles are useful once found. **Change:** include a Home destination or rename You to a label that covers both personal and workspace navigation; expose New task from Home/Chats. **Evidence:** `47-mobile-home.png`, `48-mobile-you.png`, `53-mobile-chats.png`.

**M9 — Verified: Skills lack an everyday starting point and the Read view still speaks to an AI.** “Do I need to install something to get dinners? Most of these sound like office or programming jobs.” The simple explanation is good, but library examples and the inspected detail include pull requests, `memory_search`, vault paths and Markdown template code. **Change:** add everyday examples, explain that ordinary requests do not necessarily require a skill, show plain “What this does / What it needs / Example result,” and disclose full instructions separately. **Evidence:** `34-skills.png`, `35-skill-detail.png`.

**M10 — Verified: Advanced removes helpful guidance instead of only revealing options.** “I switched to see more, but the account explanations disappeared and Home no longer tells me how to get Sam ready.” **Change:** retain readiness, cost/account explanations and recovery actions in both modes; let Advanced expand the available detail. **Evidence:** `11-which-ai.png` versus `61-ai-advanced.png`; `47-mobile-home.png` versus `76-mobile-advanced-home.png`; `36-agents-list.png` versus `60-agents-advanced.png`.

**M11 — Verified: Help’s token definition does not explain the token mentioned in setup.** “Help says a token is how AI charges me. Setup says it is shown once and saved on a device. Am I being charged to connect?” **Change:** call the setup secret a Connection code and distinguish it from AI usage tokens in Help. **Evidence:** `04-connect-mac.png`, `05-command-option-redacted.png`, `74-help-glossary.png`.

**M12 — Verified: Important desktop Settings navigation is hidden behind the user name.** “The instructions say Settings, but I don’t see a Settings button.” I found App behavior in Martin’s account menu; About you also provides a helpful direct link. **Change:** add a labeled Settings entry or gear with a visible label in the main navigation, retaining the contextual About you link. **Evidence:** `06-home.png`, `21-about-you.png`, `41-account-menu.png`, `42-settings-simple.png`.

### Low

**L1 — Verified: Account setup asks for a workspace before explaining why one is needed.** “Is this for my job? I just want something for home.” **Change:** add one plain sentence and a default personal workspace name, or explain the product before account creation. **Evidence:** `01-start.png`, `02-welcome.png`.

**L2 — Verified: About you has two competing add-entry controls initially.** “Should I use Remember this or Add to Preferences?” The large Remember this box disappears after the first preference; the smaller Add control remains. **Change:** use one persistent input with an optional category picker and consistent confirmation. **Evidence:** `21-about-you.png`, `22-preference-saved.png`, `27-preference-persisted.png`.

**L3 — Verified: Help’s escalation path assumes comfort with GitHub.** “I don’t know what an issue is or whether I need another account.” The reporting instructions themselves are clear and ask users to omit private details. **Change:** offer Report a problem with a short in-app form or copyable diagnostic summary, keeping GitHub as an optional destination. **Evidence:** `07-help.txt`, `59-help-advanced.txt` (Report a problem section). External reporting was not attempted.

### Potential / untested concerns

**P1 — High, Potential/untested: The displayed local address may fail when used on another computer.** “You say another computer can connect, so I would copy the address exactly.” The observed address was localhost and the UI offered another-computer instructions. Cross-machine connection was not attempted, and the intentional local test deployment may explain this. **Change:** detect a local-only address and provide an appropriate connection/share-address flow or clearly constrain the instructions to this computer. **Evidence:** `04-connect-mac.png`, `05-command-option-redacted.png`.

**P2 — High, Potential/untested: Mac download and external account setup may add further blockers.** “If the download fails or the Mac refuses to open it, I won’t know what to do.” The exact release link and All releases option were visible; availability, architecture compatibility, OS prompts and installation were not tested. **Change:** validate the supported installer path with a genuine novice and provide visible troubleshooting for common installation failures. **Evidence:** `04-connect-mac.png`.

**P3 — Medium, Potential/untested: Hiding headless operation may obscure a simpler text-only setup.** “Do I really need a whole desktop for a dinner list?” Advanced exposed “Run it headless: no computer, so no apps or websites”; Simple put more options behind a disclosure. This test did not enable or run that option, so it does not establish that it would solve setup. **Change:** investigate a plain “Writing and planning only” path, if the product can support it without expert setup. **Evidence:** `13-where-work.png`, `62-workspace-advanced.png`.

**P4 — Medium, Potential/untested: Narrow-screen typing and accessibility may reveal additional problems.** “Will the keyboard cover Send, and can I tell which icon does what?” Viewport screenshots looked usable, but no physical phone keyboard, touch interaction, screen reader or contrast audit was performed. **Change:** test the same task and note flows on real phones and with keyboard/screen-reader users; preserve visible action names. **Evidence:** `49-mobile-new-task.png`, `52-mobile-note.png`, `54-mobile-chat.png`, `56-mobile-app-behavior.png`.

## What worked well

- Welcome examples connect Warren to ordinary needs and Simple is recommended without requiring technical understanding.
- Simple mode actually persisted; Help and Settings both confirmed it, and Advanced caused observable changes.
- Dashboard names the readiness problem; queued AI requests explicitly say why they are waiting when a helper is addressed.
- Help updates with the current helper/device state, explains concepts, and offers a welcome replay.
- Helper creation permits a draft/offline helper and warns clearly before creation.
- About you saved a preference without any AI connection; Memory saved and reopened a note in the app.
- Search found the note, task, preference and routine using ordinary words, with useful context and a working result link.
- Routine creation uses everyday frequency/day/time controls, an understandable schedule summary and optional steps.
- Phone screens reflowed well in the inspected viewport; You’s subtitles explain many destinations better than the desktop sidebar.
- Connected apps explains that helpers do not receive the user’s password and identifies third-party publishers. These are useful explanations even though provider selection remains hard.

## Selected screenshot walkthrough

The full evidence set remains in `evidence/`; the representative screens below follow the tested journey.

**Step 1 — Welcome and Simple choice (initial smaller viewport).**

![Welcome with everyday examples and Simple recommended](evidence/02-welcome.png)

**Step 2 — The first blocker: connecting a Mac.**

![Mac download and connection instructions](evidence/04-connect-mac.png)

**Step 3 — A clear readiness message.**

![Dashboard says the helper is not ready](evidence/06-home.png)

**Step 4 — Helpful AI descriptions, still a technical prerequisite.**

![Which AI do you use](evidence/11-which-ai.png)

**Step 5 — Request saved, no dinner answer.**

![Dinner task queued while Sam is offline](evidence/16-dinner-task-result.png)

**Step 5 — Weekly scheduling is understandable.**

![Weekly schedule with day, time and timezone](evidence/39-weekly-schedule.png)

**Step 5 — Phone layout works, note actions lose visible labels.**

![Phone Memory note with icon actions](evidence/52-mobile-note.png)

**Step 6 — Advanced shows more options and fewer explanations.**

![Advanced AI picker](evidence/61-ai-advanced.png)

## Compared with the earlier audit

Read `/Users/yugpatel/kodi/USABILITY_IMPROVEMENTS.md` only after all browser testing and the independent findings above were complete. This comparison uses its written findings as historical context, not its screenshots as evidence of the current build.

| Earlier finding | What this run establishes |
|---|---|
| U04 / U06 / U40: weak orientation, disappearing setup entry, no obvious Help | Substantially improved: concrete welcome examples, persistent Finish setup after postponing, readiness card, Help and live troubleshooting checklist. Recovery still requires expertise. |
| U05 / U07 / U08: Terminal barrier, unexplained harness picker, misleading readiness | Partially improved: Mac download now leads the connection screen; three AI choices have account/cost explanations; offline creation explicitly warns and Agents says Setup incomplete. No first reply was achieved. |
| U10 / U11 / U12: technical task text, unclear waiting, channel addressing | The inspected task no longer exposed `task_update` or a raw task ID in the message, and says device rather than node. The Simple dashboard says not started. Plain channel requests still lack a routing acknowledgment. The earlier Tasks-board inconsistency was not retested. |
| U13 / U16 / U18 / U25: note editing detour, preference confusion, app setup, blank routine instructions | New note opened directly in editing mode; App behavior and About you are cross-linked; a recommended Zapier route exists; routines now ask for the desired outcome with optional steps. Raw note folders, connection compatibility and readiness remain concerns. |
| U17 / U21 / U22 / U36 / U37: badges, Teams, Shop, phone tasks, search metadata | Current badges identify publishers and explain verification; Simple omits Teams; Skill library replaces Shop; phone You now includes Tasks and New task; Search uses readable locations. Phone grouping/icon concerns remain. |

The earlier audit’s installation, permissions, backup, timezone, voice, no-helper task-modal and “last ran” claims were **not reproduced or declared fixed** here. In particular, this run did not install the Mac app, press Run now, or test live execution. The new Gemini/Zapier mismatch is a fresh observation in this journey. The overall verdict remains similar, but orientation and several manual workflows are visibly better.

**Top five fixes next:** complete the guided Mac-to-first-reply setup; make recovery resume the actual missing step; prevent incompatible AI/app choices; make chat recipients explicit; finish simplifying the helper overview and terminology.
