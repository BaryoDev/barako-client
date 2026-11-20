# Changelog

## Unreleased

- Reads (GET and HEAD) now stop after 30 s by default, with a `BarakoError` with `code: "timeout"`. Writes have no default limit. This changes a default: a read that used to wait forever now rejects. Set `timeouts: { readMs: 0 }` to keep the old behaviour. The token refresh uses `readMs`, also `auth.refresh()`. A timeout is at most 2147483647 ms, in config and per call, and a larger value throws.
- New config `timeouts` (`readMs`, `writeMs`), `signal` and `onContractMismatch`. Every method that makes a request takes a trailing `{ signal, timeoutMs }` (not `public.fileUrl` or `auth.isAuthenticated`). A per-call `timeoutMs` that config would reject throws before any request. On `contents.create` and `contents.update` the two fields join the existing options object.
- `BarakoError` has an optional `code` (`timeout`, `aborted`, `network`, `invalid-json`) and `outcomeUnknown`, set when a write timed out or lost its connection. The client never retries after a timeout or a network error.
- A failed token refresh keeps both tokens unless the API answers 400 or 401. Before, any failure signed the user out. A refresh that answers 403, 429 or 5xx rejects with "Token refresh failed." in the message and the refresh's status. A refresh 200 without a non-empty `token` is an `invalid-json` error. The refresh now uses the `baseUrl` without a trailing slash, as other calls do. A call's own `signal` and `timeoutMs` bound how long it waits for the shared refresh, and do not cancel it for other callers. A refresh that finishes after a logout, a login or a tenant switch does not write or clear the tokens. `timeoutMs` counts per attempt, so a call that gets a 401 can wait that long for the refresh and again for the retry.
- `auth.login`, `auth.logout`, `me.switch`, and `contents.create` and `contents.update` with `dryRun` count as reads, so they get the 30 s default, and a timed out dry run no longer says the outcome is unknown.
- A non-2xx response whose body cannot be read is a `BarakoError` with the response's status, not a network error.
- A write that is aborted after it was sent has `outcomeUnknown: true` and says so. An abort before it was sent does not.
- A network error reason is cut to 500 characters on one line, and `scheme://user:pass@` in it becomes `scheme://***@`. `createClient` throws for a `baseUrl` with a user or password.
- `contentTypes.list`, `contents.history` and `me.tenants` stop with an error after 1000 pages. `timeoutMs` applies per page.
- The `barako` CLI reports a client timeout, abort or network failure as a network error, exit 6.
- A 2xx answer with a body that is not JSON rejects with a `BarakoError` (`invalid-json`) instead of a `SyntaxError`. A non-JSON error body is cut to 500 characters in `message` and `body`.
- The client reads `X-Api-Contract-Version` and `X-Delivery-Contract-Version` and warns once per surface when the API is outside the supported range (a delivery header that is present but not a whole number counts as missing, and does not fall back to the admin number) (admin 1 to 16, delivery 1 to 10, exported as `SUPPORTED_CONTRACT`).
- New command `barako-client check-contract <api url> [--strict]` for CI. Exit 0 in range or newer than the client, 1 older than the client or a missing header (and newer with `--strict`), 2 unreachable, a 5xx with no contract header, or bad arguments (a URL with a user or password included). The URL's path is kept and a query or fragment is dropped.
- Known limit: a refresh that times out after the server already rotated the token leaves the client holding the old one. The server's replay rule decides what happens next.
- `me.switch()` sends the tenant as `tenant`, the name barakoCMS reads since 4.6, and still as `club` for older APIs.

## 0.5.0

- `ContentStatus` is now a string enum whose values are names ("Draft", "Published", "Archived", "Scheduled"), to match the API, which sends enums as names. Before, `entry.status === ContentStatus.Published` was always false.
- New string enums `SensitivityLevel` and `FieldMask`. `sensitivity` and `mask` are typed with them instead of `number`.
- Code that passes raw numbers (for example `setStatus(id, 1)`) must use the enum instead.
