# @baryodev/barako

Command line tool for barakoCMS content. It is built for agents and scripts: every command prints JSON.
It needs a barakoCMS server that serves the CLI routes (core 5.8.0 or later) and an API key.

## Install

```bash
npm i -g @baryodev/barako
```

Node 22.23.4 or later.

## Connect

```bash
export BARAKO_URL=https://cms.example.com
export BARAKO_API_KEY=bcms_...
```

`--url` overrides `BARAKO_URL`. `--key-file <path>` reads the key from a file and overrides
`BARAKO_API_KEY`. There is no flag that takes the key itself, so it stays out of shell history. The key
is never printed. The server works out the tenant from the key.

A key needs `content:read` to read and `content:write` to write. `content rollback` and
`content erase` also need `content:destructive`.

## Commands

Every command accepts `--url`, `--key-file` and `-o json|text`. The default is `json`.

| Command | Example |
| --- | --- |
| `commands` | `barako commands` returns `{commands, globals}`: every command and its arguments, plus the global options. Needs no connection. |
| `types` | `barako types` |
| `schema <type>` | `barako schema post` |
| `content list <type>` | `barako content list post --status published --limit 10` |
| `content get <id>` | `barako content get 3f2a...` or `barako content get --slug post/hello` |
| `content history <id>` | `barako content history 3f2a...` |
| `pages tree` | `barako pages tree` |
| `content create <type>` | `barako content create post --set Title=Hello --set Slug=hello --set-file Body=body.md` |
| `content update <id>` | `barako content update 3f2a... --set Title=New --expect-version 3` |
| `content publish <id>` | `barako content publish 3f2a...` |
| `content unpublish <id>` | `barako content unpublish 3f2a...` |
| `content archive <id>` | `barako content archive 3f2a...` |
| `content restore <id>` | `barako content restore 3f2a...` |
| `content transition <id> <name>` | `barako content transition 3f2a... approve --set Note=ok` |
| `content schedule <id>` | `barako content schedule 3f2a... --publish-at 2026-12-01T09:00:00Z` |
| `content rollback <id> <versionId>` | `barako content rollback 3f2a... 7c1d... --confirm 3f2a...` |
| `content erase <id>` | `barako content erase 3f2a... --confirm 3f2a...` |

Options worth knowing:

- `content list`: `--status draft|published|archived|scheduled`, `--search`, `--limit`, `--all` (every page, up to 5000 entries).
- `content create` and `content update`: `--set Name=value`, `--set Name:=json` for a number, boolean, array or object, `--set-file Name=path` for a value read from a file, and `--file data.json` for several fields at once. `--set` and `--set-file` win over `--file`.
- `content create`: `--publish`, `--idempotency-key`, `--dry-run`.
- `content update`: fields you do not name keep their values. `--replace` sends `--file` as the whole data. `--expect-version` stops with exit 3 unless the entry is at that version. `--dry-run` checks the change on the server and saves nothing.
- `content publish`, `unpublish`, `archive`, `restore`: `--dry-run` checks on the client and writes nothing.
- `content schedule`: sends both times on every call, so leaving out `--unpublish-at` clears it.
- `content rollback` and `content erase`: `--confirm` must equal the entry id.

## Output

Success goes to stdout, one line of JSON:

```json
{"ok":true,"result":{}}
```

Failure goes to stderr:

```json
{"ok":false,"error":{"code":"validation","status":400,"message":"...","details":null}}
```

With `-o text` the output is indented JSON on success and one `error (code): message` line on failure.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 1 | usage: a missing or unknown argument, no URL or key |
| 2 | validation or rule: the server refused the data (400, 422) |
| 3 | conflict: 409, 412, or 428 when a version is required |
| 4 | not found |
| 5 | not allowed: 401 or 403 |
| 6 | server or network error, or rate limiting (429) |

## Integration tests

The suite in `cli/test` runs the built CLI against a real server. It is skipped when `BARAKO_URL` is not set.

```bash
docker compose -f cli/test/compose.yml up -d
BARAKO_URL=http://127.0.0.1:5188 npm run test:int
docker compose -f cli/test/compose.yml down -v
```

The compose file holds test values only. Set `BARAKO_CMS_TAG` to use another core image tag.

## License

MIT
