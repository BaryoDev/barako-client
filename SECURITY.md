# Security Policy

## Reporting a vulnerability

If you find a security problem in the barakoCMS client or the `barako` command line tool, report it
privately:

1. **Do not open a public GitHub issue.**
2. Email arnelirobles@gmail.com.
3. Include a description, steps to reproduce, and the impact you see.

A problem in the API itself belongs to
[barakoCMS](https://github.com/BaryoDev/barakoCMS/security/policy); the same address takes it.

## Response timeline

- **Acknowledgment**: within 48 hours
- **Initial assessment**: within 1 week
- **Fix**: depends on severity

## Supported versions

| Package | Supported |
| --- | --- |
| `@baryodev/barako-client` | The latest published version |
| `@baryodev/barako` | The latest published version |

Both packages are pre-1.0, so a fix ships as a new release of the latest line. There is no backport
line for older versions. Upgrade to the newest release.

## Dependency advisories

CI runs `npm audit` on every pull request, on every push to `main` and nightly. A Critical or High
advisory fails the build unless `.github/audit-allowlist.json` names it with a reason and an expiry
date. An entry accepts the advisory through its expiry date and not after, so the build goes red
again and somebody looks. The list is empty today.
