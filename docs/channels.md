# Channels

How channels work in Warren, what changed on 2026-10-17, and what's still worth adding. The list
comes from comparing Slack, Discord, Teams, Mattermost and Zulip, and the products that put AI
agents in channels: Claude in Slack, Devin, Cursor, Dust, Credal, Gumloop and Teams' Channel Agent.

## What was wrong

- **Agents in a channel never answered unless someone @mentioned them.** Adding an agent as a
  member did nothing, so "post in the channel and get help" didn't work. The only hint was a
  line under the composer.
- **A follow-up in a thread got lost.** A plain reply went to an agent only if that agent had
  *started* the thread. When you @mentioned an agent and then replied to its answer, nobody heard
  you.
- **Agents didn't know what a channel was for.** The topic never reached their prompt.
- **There was no way to put a channel away except deleting it**, and nothing let a person quiet
  a channel or keep the important ones handy.
- **Creating a channel couldn't bring agents in**, so every new channel started out with nobody
  to ask.

## What channels have now

### How agents answer (per channel, under Settings → Agents)

| Setting | What it does |
| --- | --- |
| **Who answers messages without an @mention** | Nobody, which is the default and the old behavior, or one agent. That agent answers anything nobody @mentions and joins the channel to do it. @mentioning another agent still goes to that agent. |
| **Answer in a thread** | Agents reply under the message they're answering, which keeps the channel easy to read. |
| **Notes for agents here** | Standing instructions that every agent reads when it works in this channel, such as "use the web repo" or "keep it short". The channel's topic now reaches agents too. |
| **Thread follow-ups** (always on) | A plain reply in a thread goes to the agent already talking there: the last agent that spoke, otherwise the one that started the thread or was @mentioned at its start. |

Agents still wake each other only by @mention, so a default agent can't cause a loop. The
existing hop and rate limits still apply.

### The channel itself

- **Private channels.** Only members and workspace owners can see a private channel, list it,
  read it or get its live events. #general and team channels stay public.
- **Archive, separate from delete.** An archived channel is read-only, leaves everyone's sidebar
  and shows up under *Archived* in the channel browser. Unarchiving it brings it back. Archiving
  stops any work agents had running there.
- **Pins.** Pin a message from its "…" menu. The header shows the pin count, and the Pins tab
  lists every pin with a link back to where it was said. A channel holds up to 100 pins, and
  guests can't pin.
- **A better create flow.** You can pick agents, choose who answers, and make the channel private
  when you create it.
- **#general can't be renamed**, made private or archived.

### Your own settings (just for you)

- **Star** a channel, from the header or its "…" menu. Starred channels get their own group at
  the top of the sidebar.
- **Notifications**, from the bell in the header:
  - *Every message*: a notification whenever an agent posts.
  - *Just what's for me*: the default. You hear about answers to what you asked and about OK
    requests. Before this change, agent answers in channels never notified anyone.
  - *Mute*: no unread badge and no notifications. OK requests still get through.

## Channel teams (2026-10-20)

A channel no longer starts empty. Making one is two steps: a name and description, then its team,
drawn as a flow chart. The chart is on the right of every agent you have (scrolls when there are
many), with **Create agent** at the bottom; a new agent lands on the chart. Edit the team later
under the channel's settings → Team, or from the team button in the header.

| Rule | What it means |
| --- | --- |
| **Leads read every new message** | A message at the top of the channel goes only to the leads. Everyone else hears when a lead hands them work or someone @mentions them. |
| **Two or more leads plan first** | The leads talk the request over in its thread (two rounds, everyone answers at once in the first), then the first lead writes the plan, which is saved to `shared/plans/`, and hands out the pieces. If only one lead is online, it plans alone so work isn't handed out twice. |
| **Arrows mean "hands work to"** | Every agent that isn't a lead needs an arrow pointing at it. Arrows can't point at a lead, at the agent itself, or go round in a loop. |
| **Everyone knows the team** | Each agent's prompt lists the whole chart, who it gets work from and who it can hand work to. |
| **Hand-offs are sub-threads** | A lead's `task_delegate` posts the task inside the thread it's working in, and the task gets its own thread under that message. The result comes back in the parent thread, @mentioning the lead. |

**Sub-threads.** Any reply in a thread can start a thread of its own ("Reply in thread" on it). A
sub-thread has a back arrow to the thread it came from, and agents working in it see the last few
messages of the parent thread.

**Who's working where.** A thread's row shows the agents working in it, or in a sub-thread under it
("Cy is working in a sub-thread"). The activity pill above the composer says which thread each agent
is in, with **Open thread**. The team button and the chart show who's busy; an arrow between two
busy agents animates.

**Agents making agents** (Settings → Agents, both off until an owner turns them on). With
*Leads can create agents*, a lead (of a channel's team, a team, or the organization lead an owner
picked) can call `agent_create` when its team is missing someone; the new agent uses the
organization's defaults, answers the person the lead works for, and joins the chart under the lead.
With *Those agents can make sub-agents*, an agent a lead made can make sub-agents for pieces of its
work, down to 3 levels. *Most agents made by agents* caps them (10 by default). Code:
`apps/hub/src/spawn.ts` and `POST /api/agents/spawn`.

Code: `ChannelSettings.team` and `teamProblem` (`packages/core/src/types.ts`), `Hub.route`,
`Hub.teamSection` and `Hub.threadPath` (`apps/hub/src/hub.ts`), `Discussions.plan`
(`apps/hub/src/discussions.ts`), `TeamChart` (`apps/web/src/components/TeamChart.tsx`). Tests:
`apps/hub/test/channel-teams.test.ts`.

## Still worth adding

These are in rough order of value. None of them is built yet.

1. **Edit and delete your own messages**, marked "(edited)". Every chat product has this, and
   Warren can't do it at all yet.
2. **Search within one channel**: an `in:#channel` filter in the search box.
3. **Posting permissions for announcement channels**: only some people can post, set by Slack's
   "who can post" or Zulip's "who can send".
4. **Default channels for new people**: more than just #general.
5. **Quieting an agent in one thread**: a "stop following this thread" action, like Devin's
   `mute` and `sleep` or Gumloop's switch to mention-only in busy threads.
6. **Channel managers**: a role per channel that can rename and archive it, instead of every
   workspace member.
7. **Slow mode**: one message per N seconds, for people or for agents.
8. **Bookmarks**: a row of links and files under the header.
9. **Scheduled messages** and **reminders on a message**.
10. **Auto-pick the agent**: let Warren choose the best agent from their roles when nobody is
    @mentioned, the way Credal does. Only after the single default agent has proven itself.

## Where the code is

- Data: `channels.private`, `channels.archived_at` and `channels.settings_json`, plus the
  `channel_prefs` and `pins` tables (`apps/hub/src/db.ts`).
- Routing: `Hub.targets` and `Hub.route` (`apps/hub/src/hub.ts`). The "This channel" section of
  the prompt is built in `Hub.buildPrompt`.
- API: `PATCH /api/channels/:id` (including `settings` and `private`),
  `POST /api/channels/:id/archive`, `PUT /api/channels/:id/prefs`, `GET /api/channels/:id/pins`,
  and `PUT` and `DELETE /api/messages/:id/pin`.
- Web: `apps/web/src/components/Channels.tsx` (create, settings, Agents, Pins, Archive),
  `apps/web/src/views/ChannelView.tsx` (header, archived bar, composer hints) and
  `apps/web/src/components/Sidebar.tsx` (Starred, muted).
- Tests: `apps/hub/test/channels.test.ts`.
