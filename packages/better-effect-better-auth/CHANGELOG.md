# Changelog

## Unreleased

### Planned for v0.2

- Optional Hono request-scoped current-session integration from the `/hono`
  entry point; this remains unreleased planned work.
- The v0.2 gate covers Hono request snapshots, cleanup ownership, explicit
  Better Auth base-path/route ordering guidance, and external runtime consumers.

## [0.1.0] - 2026-08-30

### Added

- Initial independent server-side Better Auth integration release.
- Effectful endpoint, session, handler, transport-mode, plugin, and typed error
  adapters for an existing Better Auth instance.

### Tested peer matrix

| Peer            | Minimum tested | Current tested |
| --------------- | -------------- | -------------- |
| `better-auth`   | `1.7.0`        | `1.7.2`        |
| `better-effect` | `0.12.0`       | `0.13.0`       |
| `better-result` | `3.0.0`        | `3.0.0`        |
| TypeScript      | `5.7.2`        | `6.0.3`        |

The release gate also runs the packed consumer on Node.js `24.x` and Bun
`1.3.14`. The declared peer ranges remain `better-auth` `^1.7.0`,
`better-effect` `>=0.12.0 <0.14.0`, `better-result` `^3.0.0`, and TypeScript
`>=5.7.0`.

### v0.1 non-goals

- server-side only in v0.1;
- no client hooks or React/Vue/Svelte/Solid adapters;
- no framework middleware helpers or framework subpaths;
- no implicit `CurrentAuthSession` or request-scoped session integration;
- no roles, policy, or authorization engine;
- no automatic conversion to application-domain failures;
- no retry, timeout, or circuit-breaker policies;
- no database adapter;
- no database migrations;
- no environment or configuration ownership;
- no Runtime or dependency-container ownership;
- no official Better Auth-maintained integration or compatibility guarantee.

This package adapts an existing Better Auth instance and does not create or
own Better Auth, database, environment, Runtime, or dependency-container
lifecycle. Better Auth remains responsible for its public server APIs and
plugin compatibility.

This package is released independently from `better-effect` with the qualified
Git tag `better-effect-better-auth-v0.1.0`.
