# Changelog

## Unreleased

### Added

- Added lazy `BetterAuth.make(tag, rawFactory)` with contextual Service
  requirements and concrete Better Auth/plugin type preservation.
- Added borrowed `BetterAuth.from(tag, rawAuth)` and kept
  `BetterAuth.service(tag, rawAuth)` as its deprecated compatibility alias.

## [0.1.0] - 2026-08-31

### Added

- Initial independent server-side Better Auth integration package.
- Effectful endpoint, session, handler, transport-mode, plugin, and typed error
  adapters for an existing Better Auth instance.
- Optional Hono request-scoped session and Better Auth hooks integrations using
  caller-owned Runtimes and explicit failure policies.

### Tested peer matrix

| Peer            | Minimum tested | Current tested |
| --------------- | -------------- | -------------- |
| `better-auth`   | `1.7.0`        | `1.7.2`        |
| `better-effect` | `0.12.0`       | `0.13.0`       |
| `better-result` | `3.0.0`        | `3.0.0`        |
| TypeScript      | `5.7.2`        | `6.0.3`        |

The preparation gate also runs the packed consumer on Node.js `24.x` and Bun
`1.3.14`. The declared peer ranges remain `better-auth` `^1.7.0`,
`better-effect` `>=0.12.0 <0.14.0`, `better-result` `^3.0.0`, and TypeScript
`>=5.7.0`.

### v0.1 non-goals

- server-side only in v0.1;
- no client hooks or React/Vue/Svelte/Solid adapters;
- no implicit/global `CurrentAuthSession`; request-scoped sessions must be
  created explicitly with the optional Hono entry point;
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

This package is released independently from `better-effect` through the
qualified `better-effect-better-auth-v<version>` tag route.
