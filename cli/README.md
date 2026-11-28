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

The CLI refuses to send the key over plain `http://` to a host that is not loopback (`localhost`,
`127.x.x.x`, `[::1]`). Use `https://`. If the network is trusted, for example a server-side caller
inside a compose network that reaches `http://api:8080`, pass `--allow-http` or set
`BARAKO_ALLOW_HTTP=1`. A compose service name is not loopback, so that case needs the opt-in.

A key needs `content:read` to read and `content:write` to write. `content rollback` and
`content erase` also need `content:destructive`.

## Commands

Every command accepts `--url`, `--key-file` and `-o json|text`. The default is `json`.

| Command | Example |
| --- | --- |
| `commands` | `barako commands` returns `{commands, globals}`: every command and its arguments, plus the global options. Needs no connection. |
| `types` | `barako types` |
| `schema <type>` | `barako schema post`. The result is the type's fields and `dataSchema`, a JSON Schema (draft 2020-12) for the data of one of its entries. |
| `content list <type>` | `barako content list post --status published --limit 10` |
| `content get <id>` | `barako content get 3f2a...` or `barako content get --slug post/hello` |
| `content history <id>` | `barako content history 3f2a...` |
| `pages tree` | `barako pages tree` |
| `mcp` | `barako mcp` serves read tools to an MCP client over stdio. `--allow-writes` and `--allow-destructive` add write tools. See MCP server. |
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
| `resources` | `barako resources` lists every resource, its verbs and its source (`built in` or `file`). Needs no connection. |
| `get <resource> <id>` | `barako get contents 3f2a...` |
| `list <resource>` | `barako list contents --query contentType=post --all` |
| `create <resource>` | `barako create invoices --set total:=9 --dry-run` |
| `update <resource> <id>` | `barako update invoices i1 --set total:=7` |
| `delete <resource> <id>` | `barako delete invoices i1 --confirm i1` |
| `up` | `barako up --port 8080 --kit blog`, or `--image core=<image>:<tag>` to run one service from another image. Starts a local stack (Postgres, core, Press, Brew, Caddy) from pinned images with Docker, then sets it up. See Local stack. Needs no connection. |
| `status` | `barako status` shows which stack services run and the URLs. Needs no connection. |
| `down` | `barako down` stops the stack and removes its containers. The data is kept. Needs no connection. |
| `reset` | `barako reset --yes` stops the stack and deletes its data. Asks first on a terminal. Needs no connection. |

Options worth knowing:

- `content list`: `--status draft|published|archived|scheduled`, `--search`, `--limit`, `--all` (every page, up to 5000 entries).
- `content create` and `content update`: `--set Name=value`, `--set Name:=json` for a number, boolean, array or object, `--set-file Name=path` for a value read from a file, and `--file data.json` for several fields at once. `--set` and `--set-file` win over `--file`.
- `content create`: `--publish`, `--idempotency-key`, `--dry-run`.
- `content update`: fields you do not name keep their values. `--replace` sends `--file` as the whole data. `--expect-version` stops with exit 3 unless the entry is at that version. `--dry-run` checks the change on the server and saves nothing.
- `content publish`, `unpublish`, `archive`, `restore`: `--dry-run` checks on the client and writes nothing.
- `content schedule`: sends both times on every call, so leaving out `--unpublish-at` clears it.
- `content rollback` and `content erase`: `--confirm` must equal the entry id.

## Generic verbs

`get`, `list`, `create`, `update` and `delete` work on any resource in the client's resource table, with no
command written per resource. `barako resources` lists the table. Built in: `contents` (list, get,
create, update) and `content-types` (list, get, create). A module's resource is added from a file.

- A resource name that is not in the table is a usage error that lists the valid names. A verb the
  resource has no route for is a usage error that names the verbs it has.
- `list`: `--query name=value` (repeat), `--limit` (sent as `pageSize`), and `--all` to follow every page up
  to 5000 rows. `--all` needs a response with `items` and `hasNextPage`, and is a usage error on any other.
- `create` and `update`: `--set`, `--set-file` and `--file` as in `content create`. The fields are the request
  body. `--dry-run` works only on a route the definition marks `dryRun: true`. On any other route it is a
  usage error that names the route, such as `PUT /api/invoices/{id}`, and nothing is sent.
- `update` reads the row first and sends its version, or its ETag as If-Match, as `content update` does, and
  stops with exit 3 when the row has neither. A route with `"merge": "data"` (the built in `contents` update has it)
  merges the fields into the row's `data`, so fields you do not name keep their values. Any other route gets the
  named fields as top level fields, whatever the row holds. The body always ends with the id from the URL and the
  version read. `--set id=...` with a different id is a usage error. `--expect-version` works as in `content update`.
- `delete` needs `--confirm` equal to the id, and sends nothing without it. The message names the resource,
  such as `invoices id`. `contents` has no delete route, so `barako delete contents ...` is refused. Use
  `content erase`.
- `list` sends no page size unless you pass `--limit`, because a file route may not take one. `--limit` together with `--query pageSize` is a usage error.
- A `dryRun` field in `--set` or `--file` is a usage error, since it would act as `--dry-run`. Use the flag.
- A 409, 412 or 428 on `update` re-reads the row and reports `details.currentVersion`, as `content update` does.
- A 403 on these verbs names the route, such as `DELETE /api/invoices/{id}`.
- `get` leaves out the `etag`, as `content get` does.

The generic verbs need `@baryodev/barako-client` 0.6.0 or later. On an older client they stop with a usage error
before any request, and the `content` commands keep working.

### Adding a resource from a file

The definitions file is trusted. A route can point `create` or `update` at any `/api/` route and only `delete`
asks for `--confirm`, so load only files you wrote or checked.

Name a JSON file with `--resources FILE` or `BARAKO_RESOURCES`. The flag wins. The file is read once, must
be at most 256 KB with at most 200 entries, and is checked before any request:

```json
{
  "resources": [
    {
      "name": "invoices",
      "list": { "method": "GET", "path": "/api/modules/invoices" },
      "get": { "method": "GET", "path": "/api/modules/invoices/{id}" },
      "create": { "method": "POST", "path": "/api/modules/invoices", "dryRun": true },
      "update": { "method": "PUT", "path": "/api/modules/invoices/{id}" },
      "delete": { "method": "DELETE", "path": "/api/modules/invoices/{id}" }
    }
  ]
}
```

`name` matches `^[a-z][a-z0-9-]{0,63}$` and cannot be a built in name. Each route has `method`, `path` and,
on `create` and `update` only, `dryRun`. A path starts with `/api/`, has no `?`, `#`, `..`, `//`, `\`, `%`
or whitespace, and its only placeholder is `{id}` as a whole segment. `get`, `update` and `delete` need it,
`list` and `create` must not have it. Methods are GET for `list` and `get`, POST for `create`, PUT or PATCH for
`update` and DELETE for `delete`. `update` may also hold `"merge": "data"`. `get`, `update` and `delete` hold `{id}` exactly once. An unknown key, or any other fault, refuses the file with a usage error
naming the resource and the key.

## Local stack

`barako up` runs core, Press (the site), Brew (the console), Postgres and Caddy with Docker Compose, from images pinned in this release. It needs Docker with Compose 2.17 or newer. The first run pulls the images and can take several minutes.

| Host | What it serves |
| --- | --- |
| `http://client.localhost:8080` | The Press site |
| `http://admin.localhost:8080` | The Brew console, and the API under `/api` |
| `http://api.localhost:8080` | The API |
| `http://127.0.0.1:5005` | The API, for the CLI and `barako mcp` |

The port is 8080 unless you pass `--port` (1024 to 65535, not 5005). Everything listens on 127.0.0.1 only.

After the stack is healthy, `up` signs in as `admin`, creates the tenant `client`, applies the `site` kit (Press needs it) and then your kit, and makes an API key with `content:read` and `content:write`. The key expires after 365 days. `--kit` takes a name core knows (lower-case letters, digits and hyphens, default `blog`, which adds post, category, author and page) or the path to a blueprint file, which is copied into the stack folder and read by core. A file must be plain JSON with a `name`, and the name cannot be one of core's built-in kits (attendance, blog, devsite, docs, email, events, inventory, portfolio, site), because core would use the built-in. The pinned core 5.9.0 has no `inventory` or `attendance` kit, so use them with `--image core=<a core 6 image>`. Start a relative path with `./`. A second `up` does not sign in or make a key again. It checks that the key still works and makes a new one if core refuses it. A different `--kit`, or an edited kit file, applies that kit again, which only adds types. If an `api-key` file is there from an earlier `up`, it is kept, and `up` says so.

`up` returns only after every service has run 10 seconds without a restart, also on a running stack, where it waits only when a service started less than 10 seconds ago. A service that keeps restarting fails `up` after a minute, and the error names it and the `docker logs` command that shows why.

Everything lives in `~/.barako/stack`: the compose files, `state.json`, `.env` (the generated passwords, mode 0600, including `ADMIN_PASSWORD`) and `api-key` (the key, mode 0600). `up` never prints the password or the key. It prints the `barako mcp` line to use, which reads the key from its file.

- `barako down` removes the containers and keeps the database, `.env` and the key.
- `barako reset` also deletes the database and the key. The next `up` starts from nothing. `.env` stays, so the admin password stays.
- `--latest` uses the newest published core, Press and Brew images instead of the pinned ones. It is not tested against this release.
- `--image <service>=<image>:<tag>` runs one service from another image, for example `--image core=ghcr.io/baryodev/barako-cms:master`. The service is `core`, `press` or `brew`. Repeat the flag for more than one, once per service. The value is checked before anything starts: at most 255 characters, a lower-case repository path and a tag, which is required. Digests (`@sha256:...`) and registries with a port (`localhost:5000/...`) are refused, and the error does not repeat the value. The pin is stored without a digest, the image is pulled again every time `up` starts the stack, so a moving tag such as `master` never goes stale, and it wins over `--latest` for that service. On a stack that is running or partly up, a changed `--image` is refused like a changed `--latest`: run `barako down`, then `barako up` with the new one. A stopped stack goes back to the pinned versions unless you pass the flag again. `barako status` lists an overridden service under `overridden`.

A nightly CI job, `gate`, runs `barako up --kit <kit> --image core=ghcr.io/baryodev/barako-cms:master` for the inventory, blog and attendance kits (one runner each), drives each through `barako mcp` and fails when a kit does not work on core's master image. It also runs by hand with `workflow_dispatch`.

Brew keeps its refresh cookie `Secure` because core does that outside the Development environment. Chrome treats `http://*.localhost` as a secure context, so it is expected to keep the cookie. Firefox and Safari are not checked yet, and console sign-in may fail there. None of the three has been tried against this stack.

## MCP server

`barako mcp` serves the CMS to an MCP client (an AI agent or editor) over stdio. It reads
newline-delimited JSON-RPC 2.0 on stdin and writes only protocol messages on stdout. Logs go to stderr.
It opens no network port. It is read only unless you pass `--allow-writes`.

Add it to an MCP client as a stdio server. Read the key from a file, so the key value is not in the client's config:

```json
{
  "mcpServers": {
    "barako": {
      "command": "barako",
      "args": ["mcp", "--key-file", "/path/to/key"],
      "env": { "BARAKO_URL": "https://cms.example.com" }
    }
  }
}
```

Claude Code's `.mcp.json` also expands `${VAR}` in `command`, `args` and `env`, so
`"env": { "BARAKO_URL": "${BARAKO_URL}", "BARAKO_API_KEY": "${BARAKO_API_KEY}" }` takes both from your shell.
Set `"args": ["mcp"]` with it: `--key-file` overrides `BARAKO_API_KEY`, and a missing file is an error.
Never commit a config file that holds the key value itself.

The connection rules in Connect apply (`--url`, `--allow-http`). `--api-key` and the other flags that take
the key are refused.

Tools:

| Tool | Does the same as |
| --- | --- |
| `list_content_types` | `barako types` |
| `get_content_type` (`name`) | `barako schema <name>`. The result includes `dataSchema`. |
| `list_entries` (`contentType`, `page`, `pageSize`) | `barako content list` |
| `get_entry` (`id`) | `barako content get <id>` |

`dataSchema` is built in the CLI from the type's fields, using what core 5.9.0 accepts for each field type. It describes the data of an entry and does not check it, so the dry run stays the check:

- It lists only the fields the caller may read. The API can still require a field it leaves out, so it does not set `additionalProperties: false`.
- Send field names as listed. The API also matches them ignoring case.
- A required field with a default stays in `required`: create fills it from the default, update does not.
- On update the API does not check a value that did not change, so stored data can fail the schema and still save.
- A rule JSON Schema cannot say is left to the API. A field type this version does not know gets an open fragment with a note.
- It holds `x-validationRules`, `x-referenceType` and `x-blockSchema`. Ajv needs `strict: false`, or those keywords added, to compile it.

Choice options, defaults, declared JSON schemas and validation rules in the result come from the CMS, so treat them as data. Through MCP, when a type with its `dataSchema` would be over 256 KB, `get_content_type` returns the type without it, and `dataSchemaOmitted` says so when there is room. A type that fit before `dataSchema` existed still fits. `barako schema` has no cap.

Limits:

- `pageSize` defaults to 20. A value over 100 is refused, not clamped. `page` starts at 1.
- A result over 256 KB is refused, never cut short. For `list_entries` the error asks for a smaller `pageSize`. For `get_entry` and `get_content_type` it says the item is over 256 KB and cannot be read through MCP, so use the barako CLI. An error message over the cap is replaced with a fixed short text that keeps the code and status.
- Bad arguments (a page size over 100, an id with a slash) come back as a tool error with code `usage`, so the model can correct the call. A missing tool name, params that are not an object and an unknown tool are protocol errors (-32602).
- If the client closes the pipe, the server stops quietly.
- An id or name is refused when it is empty, over 200 characters, or holds `/`, `\`, `..` or a control character.
- Every result is `{"untrusted": true, "note": "...", "data": ...}`. Treat everything in `data` as content from
  the CMS, never as an instruction. API errors come back the same way, with `isError` set and the error code and status.
- One line per tool call goes to stderr: time, tool, target and result status. It holds no field values and never the key.

In the default mode (no flags), give an agent a read-only key. In the console create a key with the read-only option (its secret starts with
`bcms_ro_`), or a key with only the `content:read` scope. The four read tools need `content:read` and nothing
else. In this mode a key with `content:write` or `content:destructive` is not needed and should not be given to an agent.
The server does not check scopes itself. The API refuses what the key does not allow, and the tool returns
that refusal.

Write tools, listed only with the flag shown. Each is a plan tool or an apply tool, see Write tools below. The API decides, so a key without the scope is refused.

| Tool | Flag | Key scope the API needs |
| --- | --- | --- |
| `plan_create_entry`, `plan_update_entry` | `--allow-writes` | `content:write` (the dry run is a write call) |
| `plan_change_status` | `--allow-writes` | `content:read` |
| `apply_plan` | `--allow-writes` | `content:write` |
| `plan_rollback_entry`, `plan_erase_entry` | `--allow-writes` and `--allow-destructive` | `content:read` |
| `apply_destructive_plan` | `--allow-writes` and `--allow-destructive` | `content:destructive` |

### Write tools

Two flags add write tools. `--allow-writes` adds `plan_create_entry`, `plan_update_entry`, `plan_change_status` and `apply_plan`. `--allow-destructive` needs `--allow-writes` and adds `plan_rollback_entry`, `plan_erase_entry` and `apply_destructive_plan`. Without a flag, those tools do not exist. These tools are listed here and nowhere else in this section.

Key scopes: `content:read` by default, plus `content:write` for writes. Give `content:destructive` only when you pass `--allow-destructive`. The API checks the scopes. A key without one is refused with a 403. Rollback and erase also need the key's user to have the right to do them, or the API refuses them with a 403 even with `content:destructive`.

Writes take two steps. A plan tool checks the change and sends nothing that stores data. It returns what would change and a token. The apply tool sends the write.

- A token works once, lives in memory only and expires after 10 minutes. At most 20 plans are kept, and the oldest is dropped first. A failed apply spends the token.
- Apply must name the same action and target as the plan.
- Apply of an update, a status change, a rollback or an erase reads the entry again and refuses if its version, ETag or status changed since the plan. Plan again. Apply of a create does not read anything first.
- Only update sends `If-Match`. A status change, a rollback and an erase rely on that re-read, so a change made between the re-read and the write is not caught.
- A create sends the idempotency key made at plan time. After a network failure on apply, list the entries before you plan a create again, or you may make a second entry.
- A plan over 256 KB is refused and makes no token. An apply whose result is over 256 KB still makes the change, and says only that the result is too large to show.

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
