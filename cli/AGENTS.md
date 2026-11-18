# Using barako as an agent

`barako` reads and writes barakoCMS content. Every command prints one line of JSON, so parse it.

- Success: stdout, `{"ok":true,"result":...}`, exit 0.
- Failure: stderr, `{"ok":false,"error":{"code","status","message","details"}}`, exit 1 to 6.
- Exit codes: 1 usage, 2 validation or rule, 3 conflict, 4 not found, 5 not allowed, 6 server or network.

Set `BARAKO_URL` and `BARAKO_API_KEY` in the environment. Never put the key in an argument, a file you
commit or your output. Use `--key-file` if you must pass a file.

Run `barako commands` once to see every command and argument.

## Write a post

Do these in order.

1. `barako schema post`. Read the fields and which are required. Use the exact field names.
2. `barako content create post --set Title=... --set Slug=... --set-file Body=body.md --dry-run`.
   Fix anything that exits 2 before going on. Nothing is saved.
3. `barako content create post ...` with the same arguments. The entry is a draft. Keep `result.id`.
   Add `--idempotency-key <value>` if you might retry.
4. `barako content get <id>`. Check the data and note `version`.
5. To change it: `barako content update <id> --set Field=value --expect-version <version>`.
   Exit 3 means someone else changed it. Run `content get` again, then decide.
6. `barako content publish <id>`. Then `content get <id>` to confirm the status.

## Rules

- Take a post down with `barako content archive <id>`. Bring it back with `content restore <id>`.
  Do not erase it. `content erase` removes the entry and its history for good, and it needs a key with
  `content:destructive` and `--confirm <id>`. Only run it when a person asked for exactly that.
- Exit 5 means the key lacks a scope or permission. Stop and report it. Do not look for another key.
- Exit 2 means the data is wrong. Read `error.message` and `error.details`, fix the fields, retry.
- Do not retry exit 3 or exit 6 in a loop. Read the entry again first.
- A content type with its own lifecycle may refuse publish and archive. Use
  `barako content transition <id> <name>` there.
