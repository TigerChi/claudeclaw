# Targeted Notify — `[notify:]` directive & shared contacts book

Lets agent-bus, cron jobs, and heartbeat deliver a message to an **explicit
platform target** (a person, group, or channel) instead of broadcasting to
every allowed user on every channel.

## Directive

```
[notify:<target>]message text[/notify]
```

Emitted anywhere in a run's output. The daemon extracts each block, delivers
its payload to the resolved target, and strips it from the output. Content is
**plain text only** — platform directives (Slack buttons, uploads, reactions)
inside a notify payload are not interpreted.

### Target forms

| Form | Example | Meaning |
|------|---------|---------|
| Recipient name / alias | `[notify:boss]...[/notify]` | Deliver to that recipient's `default` platforms (from the contacts book) |
| Name + pinned platform | `[notify:boss@slack]...[/notify]` | Deliver to one specific platform only |
| Direct addressing | `[notify:telegram:123456]...[/notify]` | One-off; platform + raw id |
| Direct with Slack thread | `[notify:slack:C0123ABC:1699999999.000100]...[/notify]` | Post into a specific thread |
| Reply context | `[notify:reply]...[/notify]` | Reserved for runs triggered by a platform message. In bus/cron/heartbeat runs there is no originating message, so it is dead-lettered. |

Reserved words (never valid as recipient names or aliases): `reply`,
`telegram`, `slack`, `line`, `discord`.

## Where it applies

| Run source | Behavior |
|-----------|----------|
| **Agent bus** | `[notify:]` blocks are always delivered. Remaining plain text follows `notify.mode` (below). |
| **Cron job** | If the output contains any `[notify:]`, ONLY those targets receive messages — the job's `channels` / `slackTarget` broadcast is skipped for that run. Without `[notify:]`, legacy behavior is unchanged. |
| **Heartbeat** | Same rule as cron. `HEARTBEAT_OK` squelching is unchanged. |
| Interactive platform sessions | Not yet wired — replies already go back to the originating chat. |

## `notify.mode` setting (per agent, `settings.json`)

```json
{ "notify": { "mode": "explicit" } }
```

- `"explicit"` (default) — agent-bus plain text is never forwarded; only
  `[notify:]` output reaches users.
- `"legacy"` — agent-bus plain-text replies are broadcast to every allowed
  user on all active channels (historical behavior); opt-in only.

Migrate agents one at a time: flip the mode to `"explicit"` once that agent's
prompts/jobs use `[notify:]` for anything a user should see.

## Contacts book (shared across agents)

```
~/.claude/claudeclaw/contacts/
├── book.json            # named recipients (edit by hand or via an agent)
├── seen/<agent>.json    # per-agent harvest shards (auto-written)
└── dead-letter.jsonl    # failed deliveries (target, error, timestamp, preview)
```

`book.json`:

```json
{
  "recipients": {
    "boss": {
      "type": "person",
      "aliases": ["the-boss"],
      "platforms": { "telegram": "123456789", "slack": "U0123ABCDEF" },
      "default": ["telegram"]
    },
    "care-group": {
      "type": "group",
      "aliases": ["care team", "night shift group"],
      "platforms": { "line": "C99887766554433221100aabbccddeeff" },
      "default": ["line"]
    },
    "ops-alerts": {
      "type": "channel",
      "platforms": { "slack": "C0AA11BB22C" }
    }
  }
}
```

Rules:

- Keyed by **entity** (person/group/channel), not platform. A person can have
  many platform addresses; a group is inherently single-platform.
- `default` — platforms used by a bare `[notify:<name>]`. Omitted/empty =
  all defined platforms. Default platforms the **sending agent** has no token
  for are skipped quietly (agents share one book but differ in platform
  access); if none of the defaults are available on that agent, the notify is
  dead-lettered. Pinned (`@platform`) and direct targets always hard-fail.
- `aliases` — alternative names; must be unique across all recipients.
- Platform address values are plain id strings. Use `{ "id": "...", "kind":
  "user" | "group" | "channel" }` when the kind can't be inferred from the id
  prefix (needed for Discord channels; Slack `U*`/`C*`, LINE `U*`/`C*`/`R*`,
  and Telegram negative-id groups are inferred automatically).
- `allowedAgents` — reserved for future per-recipient send restrictions; not
  enforced yet.

The file is read fresh on every delivery (hot-reload — no daemon restart
needed), and it lives in the machine-global claudeclaw dir so every agent
shares one book and any agent may register entries.

## Harvest (how ids get collected)

Platforms don't let a bot list its own groups — ids can only be captured when
a message arrives. Each agent daemon appends every chat it sees (user DMs,
groups, channels; with display names where the platform provides them —
Telegram group titles, LINE group summaries and profile names, Discord
usernames) into its own shard `contacts/seen/<agent>.json` (deduped, capped
at 200 entries LRU). To make a bot see a group: invite it, then send one
message there.

Promote a candidate by copying its platform/id into `book.json` under a name
you choose. The `/claudeclaw:contacts` command does this conversationally.

## Failure handling

Failed deliveries (recipient not in book, platform not configured on the
sending agent, bot not in the target group, API errors) are appended to
`contacts/dead-letter.jsonl` and logged; they never crash the run.
