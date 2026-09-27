---
description: Clear session and start fresh
---

Clear the current Claude session by backing it up and stopping the daemon. The daemon is **not** started again — you have to start it yourself afterwards.

Run:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts --clear
```

This will:
1. Rename `session.json` → `session_<index>.backup` (preserving the old session)
2. Stop the running daemon if any, and leave it stopped
3. The next `/claudeclaw:start` will create a brand new session

Report the output to the user.
