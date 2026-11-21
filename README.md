# @baryodev/barako-client

Typed TypeScript client for the [barakoCMS](https://github.com/BaryoDev/barakoCMS) headless API.
Framework-agnostic and isomorphic: it runs in Node, the browser, and edge runtimes on the global
`fetch`, with no runtime dependencies. Ships ESM, CJS, and type declarations.

- **Two auth modes.** An API key for machine callers (SDKs, CI, integrations), or a username and
  password for human apps with automatic token refresh.
- **Tenant aware.** Sends the right `X-Tenant` for multi-tenant deployments, derived from the token.
- **Typed.** Content, content types, and results are typed; failures throw a `BarakoError` carrying
  the status and the server's message.

## Compatibility

This version works with API contract 1 to 16 on the admin routes (`X-Api-Contract-Version`) and 1
to 10 on public delivery (`cms.public`, `X-Delivery-Contract-Version`). The numbers are exported as
`SUPPORTED_CONTRACT`. An API from before the delivery split sends only the admin header, and then
that number is also the delivery number. The client reads both headers on every response, including
errors, and warns when one is outside its range (see "Contract range" below). The barakoCMS release
this matches comes from reading its changelog and source, not from a run against every release.
Node 18 or later.

Some 5.0 writes are stricter: `POST` and `PUT` on contents answer 400 for a field name the content
type does not declare, which surfaces as a `BarakoError`. A tenant that is not Active answers 404
on public delivery: `public.list` throws a `BarakoError`, and `public.bySlug` and `public.menu`
return `null`.

Looking for a command line tool? See [`cli/`](cli/README.md) for `@baryodev/barako`.

## Install

```bash
npm i @baryodev/barako-client
```

## Quick start

Machine caller with an API key (create one in the barakoBrew console under Access, then API keys):

```ts
import { createClient } from "@baryodev/barako-client";

const cms = createClient({
  baseUrl: "https://your-host/barakocms-api",
  apiKey: "bcms_...",
});

const posts = await cms.contents.list({ contentType: "post", pageSize: 10 });
const one = await cms.contents.get(posts.items[0].id);
```

Human app with login. Tokens are stored and refreshed for you:

```ts
import { createClient, browserStore } from "@baryodev/barako-client";

const cms = createClient({
  baseUrl: "https://your-host/barakocms-api",
  storage: browserStore(), // localStorage; defaults to in-memory
});

await cms.auth.login("username", "password");
const tenants = await cms.me.tenants();
await cms.me.switch("acme"); // swap to another tenant you belong to
```

> `browserStore()` keeps the refresh token in localStorage, readable by any script on the page, so an XSS leaks it. Prefer the default in-memory store or a cookie-based refresh flow.

## API

`createClient(config)` returns a client with five resources, and `cms.resources`, a table for generic calls.

```ts
// auth (JWT flows)
await cms.auth.login(username, password, tenant?);
await cms.auth.logout();
await cms.auth.refresh();
cms.auth.isAuthenticated;

// me
await cms.me.tenants();
await cms.me.switch(tenantSlug);

// content types
await cms.contentTypes.list();
await cms.contentTypes.create({ name, displayName, fields });
await cms.contentTypes.readable();        // names of the types this caller may read
await cms.contentTypes.get("post");       // one readable type: its fields, lifecycle, uniqueness

// content
await cms.contents.list({ contentType?, page?, pageSize?, status?, search? });
await cms.contents.get(id);                            // includes `etag` when the server sends one
await cms.contents.bySlug("post", "my-slug");          // authoring read by type and slug
await cms.contents.create({ contentType, data, status?, sensitivity? }, { dryRun?, idempotencyKey? });
await cms.contents.update(id, { data, status?, version? }, { ifMatch?, dryRun? });
// ifMatch works for types that are not event-sourced; event-sourced types use `version`
// dryRun answers { dryRun: true, changes: [{ field, from, to }] } and stores nothing
await cms.contents.transition(id, "submit", data?);   // named lifecycle transition, data for its fields
await cms.contents.schedule(id, { publishAt, unpublishAt, version? });
// sets both times each call, null clears one; event-sourced types need `version`
await cms.contents.rollback(id, versionId);
await cms.contents.erase(id);                          // permanent, needs the erase capability
await cms.contents.setStatus(id, ContentStatus.Published);
// ContentStatus, SensitivityLevel and FieldMask are string enums holding the names the API sends ("Published").
await cms.contents.history(id);

// blocks and pages
await cms.blocks.schema();
await cms.pages.tree();

// public delivery: anonymous, published-only, for a website frontend
await cms.public.list("post", { page?, pageSize? }); // paged published entries
await cms.public.bySlug("post", "my-slug");           // one entry, or null
await cms.public.menu("main");                         // a nav menu, or null
cms.public.fileUrl(fileId);                            // a public file URL for <img src>
```

### Generic resources

`cms.resources` is a table of resources, each a name and one route per verb, and a `call` that runs one
verb through the client's own transport (auth, refresh, timeouts and the contract check apply). It is
what `barako get`, `list`, `create`, `update` and `delete` use. The built in table holds `contents`
(list, get, create, update, no delete, because `erase` stays its own call) and `content-types` (list,
get, create). Add more with `resources` on `createClient`:

```ts
const cms = createClient({
  baseUrl,
  apiKey,
  resources: [
    {
      name: "invoices",
      list: { method: "GET", path: "/api/modules/invoices" },
      get: { method: "GET", path: "/api/modules/invoices/{id}" },
      create: { method: "POST", path: "/api/modules/invoices", dryRun: true },
      update: { method: "PUT", path: "/api/modules/invoices/{id}" },
      delete: { method: "DELETE", path: "/api/modules/invoices/{id}" },
    },
  ],
});

cms.resources.names();                    // ["contents", "content-types", "invoices"]
cms.resources.definition("invoices");
await cms.resources.call("invoices", "get", { id: "i1" });
await cms.resources.call("invoices", "list", { query: { status: "open" } });
await cms.resources.call("invoices", "create", { body: { total: 9 }, dryRun: true });
await cms.resources.call("invoices", "update", { id: "i1", body: { total: 7 }, ifMatch: etag });
```

A route's `path` is a template. It starts with `/api/`, holds no `?`, `#`, `..`, `//`, `\`, `%` or
whitespace, and its only placeholder is `{id}`, which must be a whole segment. `get`, `update` and
`delete` need `{id}` once, `list` and `create` must not have it. `list` and `get` use GET, `create` POST,
`update` PUT or PATCH and `delete` DELETE. `dryRun: true` is allowed on `create` and `update` only: the
client then sends `dryRun: true` in the body when you pass `dryRun`. On any other route `call` with
`dryRun` throws a `TypeError` naming the route, before any request. The id is encoded as one path
segment, and query values are encoded like the other calls. A bad definition, or a name that is already
built in, throws from `createClient` before any request. A get or an update that answers with an object
also carries `etag` when the server sends one. `update` takes an optional `merge: "data"`, a hint for
callers such as the `barako` CLI: the row keeps its fields under `data`, so a change is merged into it.
The client itself does not read it. The built in `contents` update sets it.

### Public delivery

For a website frontend you don't need auth at all, just a base URL (and a `tenant` for a multi-tenant
deployment). The `public` resource reads only published content and never returns drafts or sensitive
fields.

```ts
const cms = createClient({ baseUrl: "https://your-cms/barakocms-api", tenant: "your-site" });

const posts = await cms.public.list("post");
const post = await cms.public.bySlug("post", params.slug); // null: render a 404
const nav = await cms.public.menu("main");
```

### Errors

```ts
import { BarakoError } from "@baryodev/barako-client";

try {
  await cms.contents.create({ contentType: "member", data: { Email: "not-an-email" } });
} catch (e) {
  if (e instanceof BarakoError && e.isValidation) {
    console.log(e.status, e.message); // 400, "Field 'Email' expects type 'email'..."
  }
}
```

### Timeouts and aborting

Reads (GET and HEAD) stop after 30000 ms by default. Writes (every other method) have no limit by
default, because a write that is cut off may still have been applied. The timeout covers the headers
and the body. Set `timeouts` on the client, where each value is `0` (no limit) or a positive number. A
request that runs out rejects with a `BarakoError` that has `code: "timeout"`.

```ts
const cms = createClient({
  baseUrl,
  timeouts: { readMs: 10_000, writeMs: 120_000 },
  signal: appController.signal,
});

// per call: the last argument of every method that makes a request
await cms.public.list("post", { pageSize: 100 }, { signal, timeoutMs: 5_000 });
await cms.contents.create(input, { timeoutMs: 600_000 }); // a slow write
```

`signal` on the client aborts every request. Every method that makes a request takes a trailing
`{ signal, timeoutMs }`. The two exceptions are `public.fileUrl` and `auth.isAuthenticated`, which
build a string or read the store and send nothing. A per-call `timeoutMs` replaces the read or write
default for that call, and `0` turns it off. A value config would reject (negative, `NaN`,
`Infinity`, not a number) throws before any request is sent. On `contents.create` and `contents.update` these fields sit in the existing
options object next to `dryRun`, `idempotencyKey` and `ifMatch`. An aborted request has
`code: "aborted"`.

Calls that save nothing count as reads, whatever their method, and use `readMs`: `auth.login`,
`auth.logout`, `me.switch`, and `contents.create` and `contents.update` with `dryRun`. A dry run that
times out does not say the outcome is unknown.

The token refresh is a POST, but it uses `readMs`. Every request that got a 401 waits on that one
refresh, so a hung refresh with no limit would hang them all. The refresh is shared, so it runs on
the client's limits. Your call's own `signal` and `timeoutMs` only bound how long that call waits for
it: an abort or a timeout there rejects your call and leaves the refresh running for the others.
`auth.refresh()` takes `readMs` too (a per-call `timeoutMs` wins), and a refresh that times out says
the outcome is unknown, because the server may already have rotated the token.

`timeoutMs` counts per attempt, not for the whole call. A call that gets a 401 can wait up to
`timeoutMs` for the refresh and then up to `timeoutMs` for the retry, on top of the first attempt.
The largest timeout is 2147483647 ms (about 24.8 days); a larger one throws, in the config and per call.

Methods that read every page (`contentTypes.list`, `contents.history`, `me.tenants`) apply `timeoutMs`
to each page, not to the whole call. The `signal` stops the whole loop. A list stops with an error
after 1000 pages, so a server that never ends its list cannot keep it running forever.

The client never retries after a timeout or a network error. The one retry it does is a request
that got a 401 after the token was refreshed. A write (anything but GET and HEAD) that times out or
loses its connection may still have been applied, so the error has `outcomeUnknown: true` and says so.
So does a write you abort after it was sent. An abort before the request was sent does not. Check
before you send it again.

### Error codes

`BarakoError` has an optional `code`:

| `code` | `status` | When |
| --- | --- | --- |
| `timeout` | 0 | The request ran past its timeout |
| `aborted` | 0 | A `signal` fired |
| `network` | 0 | DNS, connection reset, or another fetch failure |
| `invalid-json` | the response's | A 2xx answer whose body was not JSON, such as a proxy page |

An error from a non-JSON body (a proxy's HTML page) has its `message` and `body` cut to 500
characters. A JSON error body stays as parsed. The reason in a `network` error is cut to 500
characters on one line, and a `scheme://user:pass@` in it is shown as `scheme://***@`.

A failed token refresh signs you out only when the API answers 400 or 401 to it. A 5xx, a 403, a
429, a timeout or a network error keeps both tokens, and the original request rejects with that
failure so you can try again. The message starts with "Token refresh failed." and the status is the
refresh's own. A refresh that answers 200 without a non-empty `token` is an `invalid-json` error and
keeps the tokens.

`createClient` throws when `baseUrl` has a user or password. Use `apiKey` or `auth.login`.

Known limit: a refresh that times out after the server already rotated the token leaves the client
holding the old one. What happens on the next refresh is up to the server's replay rule.

### Contract range

When a response carries a contract number outside the range above, the client logs one
`console.warn` per surface (`admin`, `delivery`). Pass `onContractMismatch` to handle it yourself,
which replaces the warning. It is called once per surface and never changes a request's result. A
missing or non-numeric header gives no warning.

```ts
const cms = createClient({
  baseUrl,
  onContractMismatch: ({ surface, apiVersion, min, max }) => report(surface, apiVersion, min, max),
});
```

### check-contract

`barako-client check-contract <api url> [--surface admin|delivery|both] [--strict]` makes one `GET <url>/api/meta`
(the URL's path is kept, a query or fragment is dropped) with no auth and compares the headers with the range of the client version you installed. The
default surface is `both`. It prints one line and exits:

| Exit | Meaning |
| --- | --- |
| 0 | In range, or newer than this client (the line says "newer than this client") |
| 1 | Older than the client's minimum, or the header it needs is missing or not a whole number. With `--strict`, also newer than the client's maximum |
| 2 | The API could not be reached (network, DNS, timeout) or answered 5xx with no contract header, or the arguments are wrong. A URL with a user or password is a bad argument |

In CI, run it before the build so a breaking API change fails there and not in production:

```yaml
- run: npm ci
- run: npx barako-client check-contract https://your-cms.example.com/barakocms-api --strict
```

### Config

| Option | Purpose |
| --- | --- |
| `baseUrl` | API base URL (required) |
| `apiKey` | `bcms_...` key for machine auth (no login, no X-Tenant) |
| `token` / `refreshToken` | Start JWT auth from existing tokens |
| `tenant` | Force the X-Tenant for JWT auth (otherwise read from the token) |
| `storage` | Where JWT tokens live: `memoryStore()` (default) or `browserStore()` |
| `fetch` | Custom fetch, for interception or a runtime without a global one |
| `timeouts` | `{ readMs, writeMs }`, headers and body. Reads default to 30000, writes to 0 (no limit) |
| `signal` | An `AbortSignal` that aborts every request of the client |
| `onContractMismatch` | Called once per surface when the API's contract is outside the supported range |
| `resources` | Resource definitions to add to `cms.resources`. See Generic resources |

## License

[MIT](LICENSE)
