# Changelog

## Unreleased

- Every request now has a timeout, 30000 ms by default, covering headers and body. This changes a default: a request that used to wait forever now rejects with a `BarakoError` with `code: "timeout"`. Set `timeoutMs: 0` on the client to keep the old behaviour.
- New config `timeoutMs`, `signal` and `onContractMismatch`. The `cms.public` methods (`list`, `bySlug`, `menu`) take a trailing `{ signal, timeoutMs }`. Other resources do not yet.
- `BarakoError` has an optional `code` (`timeout`, `aborted`, `network`, `invalid-json`) and `outcomeUnknown`, set when a write timed out or lost its connection. The client never retries after a timeout or a network error.
- A failed token refresh keeps both tokens unless the API answers 400 or 401. Before, any failure signed the user out.
- A 2xx answer with a body that is not JSON rejects with a `BarakoError` (`invalid-json`) instead of a `SyntaxError`. A non-JSON error body is cut to 500 characters in `message` and `body`.
- The client reads `X-Api-Contract-Version` and `X-Delivery-Contract-Version` and warns once per surface when the API is outside the supported range (admin 1 to 16, delivery 1 to 10, exported as `SUPPORTED_CONTRACT`).
- New command `barako-client check-contract <api url>` for CI. Exit 0 in range, 1 outside or missing, 2 unreachable.

## 0.5.0

- `ContentStatus` is now a string enum whose values are names ("Draft", "Published", "Archived", "Scheduled"), to match the API, which sends enums as names. Before, `entry.status === ContentStatus.Published` was always false.
- New string enums `SensitivityLevel` and `FieldMask`. `sensitivity` and `mask` are typed with them instead of `number`.
- Code that passes raw numbers (for example `setStatus(id, 1)`) must use the enum instead.
