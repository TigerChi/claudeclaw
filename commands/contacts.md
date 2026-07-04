---
description: "Manage the shared notify contacts book (~/.claude/claudeclaw/contacts/). Triggers: contacts, contact book, notify targets, add contact, promote contact, list contacts, set default platform, add alias, dead letters, who can I notify"
---

Manage the shared contacts book used by the `[notify:<target>]` directive.
Full reference: `docs/NOTIFY.md` in the plugin root.

Files (machine-global, shared by all agents):

- `~/.claude/claudeclaw/contacts/book.json` — named recipients
- `~/.claude/claudeclaw/contacts/seen/<agent>.json` — harvested candidates (auto-collected)
- `~/.claude/claudeclaw/contacts/dead-letter.jsonl` — failed deliveries

Parse `$ARGUMENTS` for the sub-command. No arguments → `list`.

## Sub-commands

### `list` (default)

1. Read `book.json` and every `seen/*.json`.
2. Show two sections:
   - **Book** — one line per recipient: name, aliases, platforms (with ids shortened), default platforms.
   - **Candidates** — harvested entries NOT yet in the book (match by platform+id), freshest first, max 15: platform, kind, name (if known), id, which agent saw it, lastSeen.
3. If the book is empty, explain promotion: pick a candidate, choose a name, run `promote`.

### `promote <candidate> <name>`

Promote a harvested candidate into the book.

1. Find the candidate in the merged `seen/*.json` — `<candidate>` may be an id, an id prefix, or a (partial) display name. Ambiguous → show matches and ask.
2. Validate `<name>`: must not be a reserved word (`reply`, `telegram`, `slack`, `line`, `discord`), must not contain `:` or `@`, must not collide with existing recipient names/aliases (case-insensitive).
3. Add to `book.json`:
   ```json
   "<name>": { "type": "person|group|channel", "platforms": { "<platform>": "<id>" }, "default": ["<platform>"] }
   ```
   Infer `type` from the candidate's `kind`. Write atomically: write to a temp file in the same directory, then rename over `book.json`.
4. Confirm what was added and show how to use it: `[notify:<name>]message[/notify]`.

### `add <name> <platform> <id>`

Manually add a recipient (or a new platform address to an existing one). Same name validation as `promote`. For Discord channel ids use `{ "id": "...", "kind": "channel" }` since Discord ids can't be kind-inferred.

### `alias <name> <alias...>`

Append aliases to a recipient. Validate each against reserved words and cross-recipient collisions before writing.

### `default <name> <platform...>`

Set the recipient's `default` platform list. Every platform must exist in the recipient's `platforms`.

### `remove <name>`

Show the recipient's entry and ask for confirmation before deleting it from the book.

### `dead-letters`

Read the last 20 lines of `dead-letter.jsonl` and summarize: when, which run, which target, what error. Suggest fixes (bot not in group → invite the bot; recipient not found → promote/add it; platform not configured → that agent lacks the platform token).

## Rules

- Always write `book.json` atomically (temp file + rename) and preserve entries you're not touching.
- Never invent platform ids — only use ids from `seen/` shards or ones the user pastes.
- Ids are sensitive-ish: show them shortened (first 8 chars + …) in listings, full only when the user asks.
