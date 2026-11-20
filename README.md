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

`createClient(config)` returns a client with five resources.

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

Every request has a timeout, 30000 ms by default, that covers the headers and the body. Set
`timeoutMs` on the client, or `0` to turn it off. A request that runs out rejects with a
`BarakoError` that has `code: "timeout"`.

```ts
const cms = createClient({ baseUrl, timeoutMs: 10_000, signal: appController.signal });

// per call, on the public resource (list, bySlug, menu)
await cms.public.list("post", { pageSize: 100 }, { signal, timeoutMs: 5_000 });
```

`signal` on the client aborts every request. A per-call `signal` or `timeoutMs` is the last
argument of the `cms.public` methods. The other resources take none yet. An aborted request has
`code: "aborted"`.

The client never retries after a timeout or a network error. The one retry it does is a request
that got a 401 after the token was refreshed. A write (anything but GET and HEAD) that times out or
loses its connection may still have been applied, so the error has `outcomeUnknown: true` and says so.
Check before you send it again.

### Error codes

`BarakoError` has an optional `code`:

| `code` | `status` | When |
| --- | --- | --- |
| `timeout` | 0 | The request ran past `timeoutMs` |
| `aborted` | 0 | A `signal` fired |
| `network` | 0 | DNS, connection reset, or another fetch failure |
| `invalid-json` | the response's | A 2xx answer whose body was not JSON, such as a proxy page |

An error from a non-JSON body (a proxy's HTML page) has its `message` and `body` cut to 500
characters. A JSON error body stays as parsed.

A failed token refresh signs you out only when the API answers 400 or 401 to it. A 5xx, a 403, a
429, a timeout or a network error keeps both tokens, and the original request rejects with that
failure so you can try again.

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

`barako-client check-contract <api url> [--surface admin|delivery|both]` makes one `GET <url>/api/meta`
with no auth and compares the headers with the range of the client version you installed. The
default surface is `both`. It prints one line and exits:

| Exit | Meaning |
| --- | --- |
| 0 | In range |
| 1 | Outside the range, or the header it needs is missing or not a whole number |
| 2 | The API could not be reached (network, DNS, timeout), or the arguments are wrong |

In CI, run it before the build so a breaking API change fails there and not in production:

```yaml
- run: npm ci
- run: npx barako-client check-contract https://your-cms.example.com/barakocms-api
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
| `timeoutMs` | Per request, headers and body. Default 30000, `0` for none |
| `signal` | An `AbortSignal` that aborts every request of the client |
| `onContractMismatch` | Called once per surface when the API's contract is outside the supported range |

## License

[MIT](LICENSE)
