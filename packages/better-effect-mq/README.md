# better-effect-mq

**Experimental message-queue foundations for `better-effect`.**

> This package is in development. Its public message-queue API has not been
> introduced yet.

`better-effect-mq` is planned as a small, ESM-first foundation for message
queue integrations built on [`better-effect`](https://www.npmjs.com/package/better-effect)
and [`better-result`](https://github.com/nitoba/better-result). It uses
`better-effect`, not Effect.

The planned delivery guarantee is **at-least-once**. Production transports and
persistence adapters will be separate packages, such as transport- or
database-specific adapters, rather than dependencies of this core package.

The core package currently exposes only its package entrypoint and the
runner-neutral `testing` entrypoint as inert boundaries. Importing either one
performs no worker bootstrap, opens no connections, and starts no background
work. Jobs, stores, workers, protocols, and their APIs will be added by later
issues.

## Installation

This package is not ready for application use yet. When the first usable API is
released, install it with its peer dependencies:

```bash
bun add better-effect-mq better-effect better-result
```

TypeScript `5.7` or newer is supported, together with the Node.js and Bun
runtime matrix used by this repository.

## License

MIT
