# Changelog

## Unreleased

- Reads (GET and HEAD) now stop after 30 s by default, with a `BarakoError` with `code: "timeout"`. Writes have no default limit. This changes a default: a read that used to wait forever now rejects. Set `timeouts: { readMs: 0 }` to keep the old behaviour. The token refresh uses `readMs`.
- New config `timeouts` (`readMs`, `writeMs`), `signal` and `onContractMismatch`. Every method on every resource takes a trailing `{ signal, timeoutMs }`. On `contents.create` and `contents.update` the two fields join the existing options object.
- `BarakoError` has an optional `code` (`timeout`, `aborted`, `network`, `invalid-json`) and `outcomeUnknown`, set when a write timed out or lost its connection. The client never retries after a timeout or a network error.
- A failed token refresh keeps both tokens unless the API answers 400 or 401. Before, any failure signed the user out.
- A 2xx answer with a body that is not JSON rejects with a `BarakoError` (`invalid-json`) instead of a `SyntaxError`. A non-JSON error body is cut to 500 characters in `message` and `body`.
- The client reads `X-Api-Contract-Version` and `X-Delivery-Contract-Version` and warns once per surface when the API is outside the supported range (admin 1 to 16, delivery 1 to 10, exported as `SUPPORTED_CONTRACT`).
- New command `barako-client check-contract <api url> [--strict]` for CI. Exit 0 in range or newer than the client, 1 older than the client or a missing header (and newer with `--strict`), 2 unreachable or bad arguments.

## 0.5.0

- `ContentStatus` is now a string enum whose values are names ("Draft", "Published", "Archived", "Scheduled"), to match the API, which sends enums as names. Before, `entry.status === ContentStatus.Published` was always false.
- New string enums `SensitivityLevel` and `FieldMask`. `sensitivity` and `mask` are typed with them instead of `number`.
- Code that passes raw numbers (for example `setStatus(id, 1)`) must use the enum instead.
