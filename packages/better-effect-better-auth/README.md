# better-effect-better-auth

**Server-side Better Auth integration foundations for `better-effect`.**

`better-effect-better-auth` is an independent package in the `better-effect`
monorepo. Better Auth remains responsible for authentication, sessions,
cookies, OAuth, plugins, database adapters, migrations, origin checks, and its
Web-standard handler. This package adapts those public server APIs to the
`better-result` and `better-effect` programming model without adding Better
Auth to the core package.

The package is currently establishing its public package and dependency
boundaries. It intentionally exports no provisional runtime API until the
typed error and effectful endpoint contracts are implemented and validated.

## Installation

```bash
bun add better-effect-better-auth better-auth better-effect better-result
```

The package is ESM-only and follows the Node.js, Bun, and TypeScript support
matrix of `better-effect`. Better Auth, `better-effect`, `better-result`, and
TypeScript are peer dependencies and remain owned by the application.

## Current scope

The initial release is server-side and framework-neutral. It does not:

- create or configure a Better Auth instance;
- choose a database adapter or run migrations;
- read environment variables;
- provide React, Vue, Svelte, or Solid client hooks;
- create a router or authorization framework;
- add Better Auth or framework dependencies to the `better-effect` core.

## License

MIT
