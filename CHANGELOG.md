# Changelog

## Unreleased

- `me.switch()` sends the tenant as `tenant`, the name barakoCMS reads since 4.6, and still as `club` for older APIs.

## 0.5.0

- `ContentStatus` is now a string enum whose values are names ("Draft", "Published", "Archived", "Scheduled"), to match the API, which sends enums as names. Before, `entry.status === ContentStatus.Published` was always false.
- New string enums `SensitivityLevel` and `FieldMask`. `sensitivity` and `mask` are typed with them instead of `number`.
- Code that passes raw numbers (for example `setStatus(id, 1)`) must use the enum instead.
