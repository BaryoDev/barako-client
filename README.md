# @baryodev/barako-client

Typed TypeScript client for the [barakoCMS](https://github.com/BaryoDev/barakoCMS) headless API.
Framework-agnostic and isomorphic: it runs in Node, the browser, and edge runtimes on the global
`fetch`, with no runtime dependencies. Ships ESM, CJS, and type declarations.

- **Two auth modes.** An API key for machine callers (SDKs, CI, integrations), or a username and
  password for human apps with automatic token refresh.
- **Tenant aware.** Sends the right `X-Tenant` for multi-tenant deployments, derived from the token.
- **Typed.** Content, content types, and results are typed; failures throw a `BarakoError` carrying
  the status and the server's message.

## Install

```bash
npm i @baryodev/barako-client
```

## Quick start

Machine caller with an API key (create one in the admin under Access, then API keys):

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

## API

`createClient(config)` returns a client with four resources.

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

// content
await cms.contents.list({ contentType?, page?, pageSize?, status? });
await cms.contents.get(id);
await cms.contents.create({ contentType, data, status?, sensitivity? });
await cms.contents.update(id, { data, status?, version? });
await cms.contents.setStatus(id, ContentStatus.Published);
await cms.contents.history(id);
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

### Config

| Option | Purpose |
| --- | --- |
| `baseUrl` | API base URL (required) |
| `apiKey` | `bcms_...` key for machine auth (no login, no X-Tenant) |
| `token` / `refreshToken` | Start JWT auth from existing tokens |
| `tenant` | Force the X-Tenant for JWT auth (otherwise read from the token) |
| `storage` | Where JWT tokens live: `memoryStore()` (default) or `browserStore()` |
| `fetch` | Custom fetch, for Node < 18 or interception |

## License

[MIT](LICENSE)
