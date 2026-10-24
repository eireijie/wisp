/**
 * Skills: reusable "how to do X" instructions, in the SKILL.md convention (a folder holding
 * SKILL.md, whose front matter names the skill and says when to use it). Installed skills are
 * written into each agent's memory folder as `skills/<slug>/SKILL.md` and listed in its prompt.
 */

/** Where a skill came from. "taught": made from a routine someone taught an agent (not built yet). */
export type SkillSource = "catalog" | "custom" | "taught";

export interface Skill {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string;
  source: SkillSource;
  /** the catalog entry it came from, if any */
  catalogId: string | null;
  tags: string[];
  /** the SKILL.md body (markdown, without front matter) */
  content: string;
  agentIds: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Vault path of a skill in an agent's private folder. */
export const agentSkillPath = (agentId: string, slug: string) => `agents/${agentId}/skills/${slug}/SKILL.md`;

export function skillSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "skill"
  );
}

/** The SKILL.md file: front matter (name, description) and the body. */
export function skillFile(s: { slug: string; name: string; description: string; content: string }): string {
  const y = (v: string) => JSON.stringify(v.replace(/\s+/g, " ").trim());
  return `---\nname: ${s.slug}\ntitle: ${y(s.name)}\ndescription: ${y(s.description)}\n---\n\n${s.content.trim()}\n`;
}

export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  /** Lucide icon name */
  icon: string;
  tags: string[];
  content: string;
  /** For people who don't want to read the instructions: plain words, no tool names or file paths. */
  plain?: { does: string; needs: string; example: string };
}

export const SKILL_CATALOG: CatalogSkill[] = [
  {
    id: "meal-plan",
    name: "Weekly meal plan and shopping list",
    description: "Use when asked to plan meals or dinners for the week, or to make a shopping list.",
    icon: "UtensilsCrossed",
    tags: ["everyday", "home", "planning"],
    plain: {
      does: "Plans a week of meals that fit your household, then writes a shopping list sorted by store section.",
      needs: "How many people, which days and meals, and any allergies, dislikes, budget or time limits. It asks if you leave something out.",
      example: "Plan dinners for next week for two people, no fish.",
    },
    content: `# Weekly meal plan and shopping list

1. **Ask only what you don't know**: how many people, which days and meals, allergies and dislikes, budget, and time limits on cooking.
2. **Propose the plan** as a simple table: day, meal, and rough cooking time.
3. **Write the shopping list** grouped by store section (produce, dairy, meat and fish, pantry, frozen), with quantities for the whole week.
4. **Note pantry staples** (oil, salt, flour, spices) as "check you have these" instead of listing them as purchases.
5. Offer to swap any meal.

Rules:
- Treat allergies and "no X" requests as strict. Never slip them in.
- Reuse ingredients across meals to cut waste and cost.
- Keep weeknight meals quick (about 30 minutes) unless told otherwise.
- No medical or nutrition claims; if asked for a health diet, suggest checking with a professional.`,
  },
  {
    id: "summarize-document",
    name: "Summarize a document",
    description: "Use when given a document, article or long message to summarize.",
    icon: "FileText",
    tags: ["everyday", "writing", "reading"],
    plain: {
      does: "Reads a document and gives you a short summary, the key points, and any dates, numbers and to-dos.",
      needs: "The document, pasted in or attached, and what you need it for.",
      example: "Summarize this contract and tell me any deadlines.",
    },
    content: `# Summarize a document

1. **If it's unclear, ask what the summary is for** (a quick read, a decision, sharing with someone) and how long it should be.
2. **Start with a summary** of 3-5 sentences.
3. **Then the key points** as a short bulleted list.
4. **Then the specifics**: dates and deadlines, amounts and numbers, and action items (who needs to do what).

Rules:
- Don't add facts that aren't in the document.
- Say so when something is unclear, missing or contradictory, rather than guessing.
- Keep to the length the person asked for.
- Keep names, dates and numbers exact.`,
  },
  {
    id: "polite-message",
    name: "Draft a polite message",
    description: "Use when asked to write or reword a message, email or note, such as a request, a reminder, a complaint or a thank-you.",
    icon: "MessageSquare",
    tags: ["everyday", "writing"],
    plain: {
      does: "Writes a short, polite message for you to send, plus a shorter and a warmer version.",
      needs: "Who it is to, what you want from them, and the tone you would like. Nothing is sent for you.",
      example: "Write a polite message to my landlord asking when the heating will be fixed.",
    },
    content: `# Draft a polite message

1. **Work out the basics**: who it's to, what the person wants from it, and the tone (formal, friendly, firm). Ask only for what is missing.
2. **Draft a short message**: a greeting, the point in the first two sentences, a clear ask (with a date if there is one), and thanks.
3. **Offer two variants**: a shorter one and a warmer one.
4. **Hand it back** for the person to read and send.

Rules:
- Never send it. The person sends it themselves.
- Keep it honest; don't exaggerate or invent details.
- Don't make promises the person didn't make.
- Plain words, no filler.`,
  },
  {
    id: "weekly-status-report",
    name: "Write a weekly status report",
    description: "Use when asked for a weekly update, status report or \"what happened this week\" for a team or project.",
    icon: "CalendarCheck",
    tags: ["writing", "reporting", "teams"],
    plain: {
      does: "Pulls together what got done, what is still in progress and what is stuck, and writes a short weekly update.",
      needs: "Which project or team the update is for. Connect the tools the work happens in (like GitHub) if you want them included.",
      example: "Write this week's status report for the website project.",
    },
    content: `# Weekly status report

## Gather
1. Work out the week: Monday to today in the requester's time zone, unless they name dates.
2. Collect what happened: finished and open tasks, merged pull requests, decisions in channels, notes in the vault (memory_search for the project name and the week's dates).
3. Ask the requester only if you can't tell which project or audience the report is for.

## Write
Use this shape, and keep it under one screen:

\`\`\`
# <Project> — week of <Mon date>
**Summary:** one or two sentences a busy reader can stop at.

## Done
- Outcome first, then the detail ("Checkout is 30% faster — cached the price lookup").

## In progress
- What, who, and when it should land.

## Blocked / needs a decision
- The question, who can answer it, and what it holds up.

## Next week
- The 3–5 things that matter most.
\`\`\`

## Rules
- Outcomes over activity: "shipped X" beats "worked on X".
- Name people and agents with @mentions only where they need to act.
- Say plainly when something slipped and why. No padding, no hype.
- Save the report to the vault (e.g. shared/reports/<project>-<yyyy-mm-dd>.md) and post the summary with a link.`,
  },
  {
    id: "triage-github-issue",
    name: "Triage a GitHub issue",
    description: "Use when given a new GitHub issue (or a batch of them) to label, reproduce, prioritize and route.",
    icon: "Bug",
    tags: ["code", "github", "support"],
    plain: {
      does: "Reads a new GitHub issue, checks for duplicates, tries to reproduce it, and suggests a label, priority and owner.",
      needs: "GitHub connected under Connected apps (or the GitHub command-line tool signed in on the helper's device), and the issue to look at.",
      example: "Triage the newest issues in our app repository.",
    },
    content: `# Triage a GitHub issue

Needs: the GitHub connector, or the \`gh\` CLI signed in.

1. **Read it fully**, including comments and linked issues. Search for duplicates (\`is:issue <key words>\`), open and closed.
2. **Classify**: bug, feature request, question, docs, or not actionable. Apply the repo's existing labels; never invent new ones.
3. **For bugs, try to reproduce** on the default branch with the steps given. Note the version, OS and exact error. If you can't reproduce, say what you tried.
4. **Find the likely code**: search for the error message, the feature's entry point, recent commits touching it (\`git log -S\`). Point to files and lines.
5. **Prioritize** with the repo's scheme, or: P0 data loss / security / everyone blocked; P1 a main flow broken, no workaround; P2 broken with a workaround; P3 polish.
6. **Comment** once, briefly: what you found, the likely cause, what's missing (ask for exactly what you need), and a suggested owner.
7. Close only obvious duplicates (link the original). Anything else that should be closed, suggest it instead.

Never promise dates. Be kind to reporters; thank them for detail.`,
  },
  {
    id: "research-brief",
    name: "Research a topic and write a brief",
    description: "Use when asked to research a question, market, technology or company and come back with a written brief.",
    icon: "Telescope",
    tags: ["research", "writing"],
    plain: {
      does: "Researches a question across several sources and writes a one or two page brief with the bottom line first.",
      needs: "The question, and what decision it will help with. Earlier notes your helper saved are used if they exist.",
      example: "Research which project tools small design teams use and write me a brief.",
    },
    content: `# Research brief

1. **Pin the question.** Restate it in one sentence and say what decision it feeds. If that's unclear and matters, ask once.
2. **Check what we already know**: memory_search the vault first, so you build on earlier work.
3. **Search widely, then read deeply.** Prefer primary sources (docs, filings, papers, official data) over summaries. Open at least 5 good sources; note the date of each.
4. **Keep a source list as you go**: title, URL, date, one line on what it supports.
5. **Separate facts from claims from your inferences**, and say how confident you are.

## The brief
\`\`\`
# <Question>
**Bottom line:** the answer in 2–3 sentences.

## What we found
- Key points, each with a source [1].

## Options / trade-offs (if it's a decision)
| Option | For | Against |

## Open questions
- What we couldn't confirm, and how to find out.

## Sources
1. Title — URL (date)
\`\`\`

Keep it to a page or two. Save it to the vault (shared/research/<topic>.md) and reply with the bottom line and a link.`,
  },
  {
    id: "review-pull-request",
    name: "Review a pull request",
    description: "Use when asked to review a pull request or a branch's changes before merging.",
    icon: "GitPullRequest",
    tags: ["code", "github", "review"],
    plain: {
      does: "Reads the changes in a pull request, runs the tests if it can, and leaves clear comments marked as must fix or small suggestion.",
      needs: "The pull request or branch to review, and GitHub connected under Connected apps if it is not pasted in.",
      example: "Review pull request 128 before we merge it.",
    },
    content: `# Review a pull request

1. **Understand the intent**: read the description and linked issue. If you can't tell what it's meant to do, ask before reviewing.
2. **Read the whole diff**, then the code around it. Check out the branch when you can; run the tests and the linter.
3. **Look for, in this order:**
   - Correctness: logic errors, edge cases (empty, null, huge, concurrent), off-by-ones, error handling.
   - Security: injection, auth checks, secrets in code, unsafe input handling.
   - Data: migrations that can't roll back, lost writes, breaking API changes.
   - Tests: does something fail if the change is wrong?
   - Clarity: names, dead code, duplicated logic, comments that lie.
4. **Write comments that help**: point at the line, say what's wrong and why, suggest a fix. Mark each as **blocking**, **should fix**, or **nit**.
5. **Summarize**: a verdict (approve / approve with nits / changes needed), the 1–3 things that matter most, and what you tested.

Don't rewrite the author's style to yours. Praise what's genuinely good, briefly.`,
  },
  {
    id: "summarize-meeting",
    name: "Summarize a meeting transcript",
    description: "Use when given a meeting transcript, recording notes or call log to turn into notes with decisions and action items.",
    icon: "NotebookPen",
    tags: ["writing", "meetings", "everyday"],
    plain: {
      does: "Turns a meeting transcript or rough notes into a short summary with decisions, action items and open questions.",
      needs: "The transcript or notes, pasted in or attached.",
      example: "Summarize this meeting transcript and list who needs to do what.",
    },
    content: `# Meeting summary

From a transcript, produce notes someone who missed the meeting can act on.

\`\`\`
# <Meeting> — <date>
**Attendees:** names
**TL;DR:** 2–3 sentences.

## Decisions
- What was decided, and by whom.

## Action items
- [ ] Owner — task — due date (if said)

## Discussion
- Topic: the gist, the options raised, where it landed.

## Open questions
- Unresolved points, and who should resolve them.
\`\`\`

Rules:
- Only list decisions that were actually made; "we should look into" is an open question, not a decision.
- Every action item has one owner. If none was named, write "owner: ?" rather than guessing.
- Attribute opinions carefully; don't put words in people's mouths. Quote sparingly.
- Drop small talk and repetition. Keep numbers, dates and names exact.
- Save to the vault (shared/meetings/<yyyy-mm-dd>-<topic>.md); post the TL;DR and action items.`,
  },
  {
    id: "customer-reply",
    name: "Draft a customer reply",
    description: "Use when asked to answer a customer email, ticket or review. Drafts for a person to send unless told otherwise.",
    icon: "Mail",
    tags: ["support", "writing"],
    plain: {
      does: "Drafts a warm, short reply to a customer email, ticket or review, and leaves it for you to send.",
      needs: "The customer message. Order or account details help if the answer depends on them.",
      example: "Draft a reply to this customer who says their order arrived damaged.",
    },
    content: `# Draft a customer reply

1. **Read the whole thread** and any account history you can see. Work out what they actually want (a fix, a refund, an answer, to be heard).
2. **Check the facts**: their order or account, the policy that applies, known issues. Never guess at policy or promise what you can't confirm.
3. **Draft**:
   - Greet them by name. Acknowledge the problem in one sentence, specifically.
   - Answer or give the next step clearly. Numbered steps if they need to do something.
   - Say what happens next and when.
   - Close warmly, with a real name/signature placeholder.
4. **Tone**: plain, warm, short. No jargon, no blame, no "per our policy". Apologize once if we got it wrong.
5. **Don't send** unless the requester said to: post the draft for review, with notes on anything you weren't sure about (refund amounts, exceptions).

Never include internal notes, other customers' data, or secrets in a reply.`,
  },
  {
    id: "careful-web-form",
    name: "Fill a form on a website carefully",
    description: "Use when asked to fill in and submit a web form (applications, registrations, orders, government or vendor portals).",
    icon: "ClipboardList",
    tags: ["browser", "computer"],
    plain: {
      does: "Fills in a form on a website step by step, checks every answer, and stops to ask you before submitting.",
      needs: "All the details the form needs, and a device or computer the helper can use. You enter passwords, card numbers and codes yourself.",
      example: "Fill in the vendor registration form on this site using the details I gave you.",
    },
    content: `# Fill a web form carefully

1. **Collect the data first.** List every field the form will need, and where each value comes from (the request, the vault, a file). Ask for anything missing *before* starting, in one message.
2. **Open the page** with the browser tools (browser_navigate, browser_snapshot). Read the whole form, including fine print and every step of a multi-page form.
3. **Fill one section at a time**, using the element refs from the snapshot. After each section, take a fresh snapshot and check every value landed in the right field (dates and phone formats especially).
4. **Never type passwords, card numbers or one-time codes yourself.** When a sign-in, payment or CAPTCHA appears, call computer_ask_human with exactly what's needed and stop.
5. **Before submitting**, stop and ask with approval_request: summarize what will be submitted (key fields, totals, what it commits to). Submit only after a yes.
6. **After submitting**, capture the confirmation (number, page text, screenshot) and save it to the vault with the date.

If anything looks off (a different site than expected, unexpected charges, a field asking for more than it should), stop and ask.`,
  },
  {
    id: "spreadsheet-cleanup",
    name: "Clean up data in a spreadsheet",
    description: "Use when given a messy CSV or spreadsheet to clean: duplicates, inconsistent formats, blanks, bad headers.",
    icon: "Sheet",
    tags: ["data", "spreadsheets"],
    plain: {
      does: "Cleans up a messy spreadsheet on a copy: fixes headers and formats, removes duplicates, and lists every change.",
      needs: "The spreadsheet or CSV file, attached. Your original is never changed.",
      example: "Clean up this customer list and remove the duplicates.",
    },
    content: `# Spreadsheet cleanup

1. **Never edit the original.** Work on a copy (name-clean.csv / a new tab).
2. **Profile first**: row count, columns, types, blanks per column, obvious duplicates, odd values. Share this summary before big changes if anything is ambiguous.
3. **Clean, in this order:**
   - Headers: one header row, unique snake_case or Title Case names, no merged cells.
   - Whitespace and case: trim, normalize emails to lowercase, names to their usual case.
   - Formats: dates to ISO (YYYY-MM-DD), numbers without currency symbols or thousands separators (keep currency in its own column), phone numbers to one format.
   - Categories: map spelling variants to one value ("NY", "New York", "new york").
   - Duplicates: decide on a key (email, ID); keep the most complete/most recent row; list what you removed.
   - Blanks: leave them blank. Never invent values.
4. **Check**: row counts before/after, totals of numeric columns still add up, spot-check 10 random rows.
5. **Report**: a short change log (what changed, how many rows, anything you weren't sure of) next to the file.

Use a script (Python/pandas or similar) for anything over a few hundred rows so the steps are repeatable.`,
  },
  {
    id: "release-notes",
    name: "Write release notes from commits",
    description: "Use when asked to write release notes or a changelog for a version, from commits, PRs and tags.",
    icon: "Rocket",
    tags: ["code", "writing", "github"],
    plain: {
      does: "Turns a list of code changes into release notes that describe what users can now do or what is fixed.",
      needs: "Access to the project's change history (GitHub connected under Connected apps), and which versions to cover.",
      example: "Write release notes for version 2.4 from the changes since 2.3.",
    },
    content: `# Release notes from commits

1. **Find the range**: the last release tag to the new one (\`git describe --tags --abbrev=0\`, \`git log <prev>..<new> --oneline\`). Include merged PR titles and descriptions where you can.
2. **Sort changes** into: Highlights, New, Improved, Fixed, Breaking changes, Under the hood. Skip pure chores (CI, typo, version bumps) unless users would notice.
3. **Rewrite for users**, not developers: what they can now do, or what no longer goes wrong. "Exports no longer time out on large workspaces" — not "fix: increase export timeout".
4. **Breaking changes** get their own section, with exactly what to change ("rename X to Y in config").
5. Credit outside contributors by handle. Link PRs.

\`\`\`
# <Product> <version> — <date>
<One-paragraph intro: the theme of the release.>

## Highlights
## New
## Improved
## Fixed
## Breaking changes
\`\`\`

Post a draft for review; don't publish or tag without being asked.`,
  },
  {
    id: "inbox-digest",
    name: "Daily inbox digest",
    description: "Use for a daily (or on-demand) digest of new email, messages and notifications: what needs a reply, what can wait.",
    icon: "Inbox",
    tags: ["email", "routine", "productivity", "everyday"],
    plain: {
      does: "Reads your new email and messages and sorts them into what needs you today, what can wait, and what to ignore. It never sends or deletes anything.",
      needs: "Your email connected under Connected apps, or a computer where your mail app is signed in.",
      example: "Give me a digest of my inbox since yesterday.",
    },
    content: `# Daily inbox digest

Needs read access to the inbox (an email connector, or the computer with the mail app signed in). Read only: never send, archive or delete unless asked.

1. Look at everything new since the last digest (check the vault for the last digest's date; default to 24 hours).
2. Sort each item into:
   - **Needs you today**: direct questions, deadlines in the next 48h, anything from people marked important.
   - **Needs a reply, not urgent**
   - **FYI**: updates, receipts, newsletters worth a glance.
   - **Noise**: promotions, automated mail (just count these).
3. For each "needs you" item: sender, subject, one-line gist, and the ask with its deadline. Offer a draft reply when it's routine.

\`\`\`
## Inbox — <date>
**Needs you today (n)**
- <Sender> — <subject>: <gist>. Ask: <what>, by <when>.
**Reply when you can (n)** …
**FYI (n)** …
**Skipped:** n promotions/automated.
\`\`\`

Keep it scannable. Save the date of this digest to the vault so the next one starts there.`,
  },
  {
    id: "compare-vendors",
    name: "Compare vendors",
    description: "Use when asked to compare tools, vendors or service providers and recommend one.",
    icon: "Scale",
    tags: ["research", "purchasing"],
    plain: {
      does: "Compares tools or providers against your needs, with prices and risks, and recommends one.",
      needs: "What you need it for, your budget and your must-haves. It does not sign up for anything.",
      example: "Compare three invoicing tools for a five person business and recommend one.",
    },
    content: `# Compare vendors

1. **Get the requirements**: must-haves, nice-to-haves, budget, team size, deadline, what we use today. Ask once if key ones are missing.
2. **Long list → short list**: find 5–8 candidates, cut to the 3–4 that meet every must-have. Say why the others were cut.
3. **For each, check from primary sources** (pricing pages, docs, security/compliance pages, status history): price at our size (monthly and yearly, with the tier we'd actually need), must-haves, integrations, limits, contract terms, support, data location.
4. **Look for honest signals**: recent reviews, changelogs, known outages, how pricing has changed.

\`\`\`
# <What we're buying>: vendor comparison
**Recommendation:** <vendor>, because … (2–3 sentences). Runner-up: …

| | Vendor A | Vendor B | Vendor C |
|---|---|---|---|
| Price at our size | | | |
| Must-haves met | | | |
| … | | | |

## Risks and unknowns
## Sources (with dates)
\`\`\`

Never sign up, start trials or contact sales without asking first.`,
  },
  {
    id: "bookkeeping-categorize",
    name: "Categorize transactions for bookkeeping",
    description: "Use when given bank or card transactions to categorize into the chart of accounts, flagging anything unclear.",
    icon: "Calculator",
    tags: ["finance", "data", "spreadsheets"],
    plain: {
      does: "Sorts bank or card transactions into your accounting categories and flags the ones it is unsure about. It moves no money.",
      needs: "The transactions as a file, and your list of categories if you have one.",
      example: "Categorize this month's card transactions and flag anything unclear.",
    },
    content: `# Categorize transactions

1. **Get the chart of accounts** (the categories in use) and last period's categorized file, if any; follow how things were categorized before. Check the vault for a "vendors → category" note.
2. **For each transaction**: date, payee, amount, then pick the category. Use the payee and amount pattern; recurring payees get the same category as before.
3. **Flag, don't guess**: transfers between own accounts, refunds, owner draws, anything over the flag limit (default 1,000), new payees you can't place, and anything that could be personal. Put these in a "Needs review" list with your best guess and why.
4. **Never** move money, pay bills, or change anything in the accounting system unless asked. Produce a file (CSV with a category column, plus a "confidence" column).
5. **Check totals** match the statement for the period.
6. Update the vault note of payee → category with new confident matches so next time is faster.

This is bookkeeping prep, not tax or financial advice; say so if asked for advice.`,
  },
  {
    id: "competitor-watch",
    name: "Watch competitors",
    description: "Use for a periodic check on competitors: pricing, launches, changelogs, hiring and news.",
    icon: "Radar",
    tags: ["research", "routine", "marketing"],
    plain: {
      does: "Checks competitors' public pages for changes in pricing, launches and news, and reports only what changed.",
      needs: "The list of competitors to watch. It looks at public pages only.",
      example: "Check what our competitors changed this week.",
    },
    content: `# Competitor watch

1. Read the list of competitors and what we track from the vault (shared/competitors.md). If there's none, ask for the list and create it.
2. For each competitor, check since the last report: pricing page, changelog/release notes, blog, social posts, job listings (they hint at plans), and news.
3. Compare against the last snapshot in the vault; report only **changes**.

\`\`\`
## Competitor watch — <date>
### <Competitor>
- **Changed:** what, with a link, and why it might matter to us.
\`\`\`
Finish with "So what": the 1–3 changes worth acting on, and a suggestion each.

Update the snapshot note so next time compares against today. Stay on public pages; never sign up or pose as a customer.`,
  },
  {
    id: "write-docs-page",
    name: "Write a how-to doc",
    description: "Use when asked to document how to do something: a guide, runbook or README section.",
    icon: "FileText",
    tags: ["writing", "docs"],
    plain: {
      does: "Writes a clear step-by-step guide for how to do something, with a troubleshooting section.",
      needs: "Who the guide is for and the task it covers. Trying the steps itself is only possible if the helper has a device.",
      example: "Write a guide for new staff on how to set up their work laptop.",
    },
    content: `# Write a how-to doc

1. **Who and what**: who's reading (new teammate, customer, on-call engineer) and the one task they're trying to finish.
2. **Do it yourself first** where you can, and note each step exactly as it happens: commands, buttons, what you see.
3. **Structure**:
   - Title as the task ("Deploy the web app").
   - One line on when you'd need this.
   - Before you start: access, tools, versions.
   - Numbered steps, one action each, with the expected result after anything that can fail.
   - Troubleshooting: the errors you hit and the fix.
4. **Style**: short sentences, second person, present tense. Copy-pasteable commands in code blocks. Exact UI labels in **bold**. No "simply" or "just".
5. Save it in the vault where the team looks for docs, and link related notes with [[wikilinks]].`,
  },
];

export function catalogSkill(id: string): CatalogSkill | undefined {
  return SKILL_CATALOG.find((s) => s.id === id);
}

/**
 * Skills every agent always has, on every harness. They aren't in the shop or the skills table:
 * the hub writes them into each agent's folder (`skills/<id>/SKILL.md`) and puts them back if
 * they go missing, so they can't be removed.
 */
export const MEMORY_SKILL: CatalogSkill = {
  id: "memory",
  name: "Keep memory tidy and linked",
  description: "Use whenever you save, update or look up something in memory (memory_write, memory_append, memory_remember).",
  icon: "BrainCircuit",
  tags: ["memory", "built-in"],
  content: `# Keep memory tidy and linked

Memory is a shared second brain: markdown notes that link to each other with \`[[wikilinks]]\`, so people and agents can find things later and see how they connect. A note nobody can find, or a second copy of a note that already exists, makes it worse. Follow these steps every time you save something.

## 1. Search first
- memory_search for the person, project or topic before writing. Open the closest matches with memory_read.
- If a note on the same idea exists, **update it** (memory_read, then memory_write the whole note with your change) instead of making a near-duplicate.
- When a save comes back with "Similar notes", read them and merge if it's the same idea.

## 2. Facts about people: memory_remember
- Something lasting about a person you work with (a preference, a plan, something they did, a detail about them): use **memory_remember**, one fact per call. It files it in their profile for you.
- Everything else (projects, topics, decisions, research, logs, people outside the workspace): use **memory_write**, or **memory_append** for logs and journals.

## 3. One idea per note, with a clear title
- One project, decision, topic or person per note. Split notes that cover several things.
- Start with a \`# Title\` that says what it is ("Acme pricing decision", not "Notes").
- File names are short, lowercase, with dashes: \`acme-pricing.md\`.

## 4. Where notes go
Use the same folders inside \`me/\` (private), \`shared/\` (everyone) and team folders:

| Folder | For |
|---|---|
| \`people/\` | one hub note per person outside the workspace (a customer, a contact) |
| \`projects/\` | one hub note per project, plus notes about it |
| \`topics/\` | subjects and reference material |
| \`journal/YYYY-MM-DD.md\` | what happened that day (memory_append) |

Decisions go next to what they decide (\`projects/acme-pricing-decision.md\`). Put things people should see in \`shared/\` or the team's folder; keep \`me/\` for your own working notes.

## 5. A small header
Start each note with front matter:

\`\`\`
---
type: decision        # person, project, topic, decision, journal or reference
source: "#general, 2026-10-17"   # where it came from: a channel, a link, a file
related: ["[[acme]]", "[[pricing]]"]
---
\`\`\`

Wisp fills in \`type\`, \`created\` and \`updated\` if you leave them out, but never changes what you wrote.

## 6. Link it
- Link to at least one existing note with \`[[note-name]]\` (the file name without .md).
- Always link the hub note for the person, project or topic it's about. If that hub note doesn't exist yet, create it: a title, one or two lines on what it is, and links to its notes.
- When a save comes back with "Mentions you could link", add the links that fit.

## 7. Never save secrets
No passwords, API keys, tokens, card numbers or one-time codes, not even in your private folder. Write where the secret lives instead ("the API key is in the GitHub connector").`,
};

export const BUILTIN_SKILLS: CatalogSkill[] = [MEMORY_SKILL];

/** Slugs built-in skills use in agents' folders; the workspace's own skills can't take them. */
export const BUILTIN_SKILL_SLUGS = BUILTIN_SKILLS.map((s) => s.id);
