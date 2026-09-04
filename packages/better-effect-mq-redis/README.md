# better-effect-mq-redis

Redis and Valkey infrastructure for [`better-effect-mq`](../better-effect-mq). It provides a namespaced client Layer, a Redis-backed `JobStore` Layer, canonical key helpers, persistence codecs, Lua script loading, and startup layout validation.

## Installation

```sh
bun add better-effect-mq better-effect-mq-redis better-effect better-result redis
```

`redis` is an optional peer. It is loaded only by `RedisClient.fromConfig`/`layerFromConfig`; applications using an already-created compatible client can use `RedisClient.layer` without the package constructing a client. The package does not import `effect` or `@effect/*` and does not make Redis a dependency of the core package.

## Client ownership

```ts
import { RedisClient } from 'better-effect-mq-redis'

const StoreLive = RedisClient.layer({
  client,
  namespace: 'notifications'
})
```

`layer` borrows the command client. The official `redis` client's `duplicate()` is used for a separate subscriber connection when one is not supplied; that duplicate is owned by the adapter and closed when the Layer Scope closes. A supplied subscriber is also borrowed. `RedisClient.layerFromConfig({ url })` creates, connects, and owns both connections and closes each at most once. Partial setup failures clean up connections that were already created.

The client must be initialized before direct use:

```ts
const redis = RedisClient.fromClients({ client, subscriber })
await redis.initialize()
await redis.dispose()
```

The Layer APIs initialize the client for you. Cleanup is idempotent and never closes a caller-owned client.

## Namespace and Cluster keys

Keys use one canonical hash tag:

```text
better-effect-mq:{notifications}:job:<id>
```

All keys produced by `makeRedisKeyLayout` share a Redis Cluster hash slot. Namespace and prefix are bounded, non-empty, well-formed text values and cannot inject hash-tag braces. Names, queues, job IDs, identities, and index members use delimiter-safe encoding. Waiting members use safe-integer, fixed-width run time and ordering sequence fields; priority is kept as a separate sorted-set score, so timestamp/sequence precision is never packed into one Redis `double`.

A namespace can therefore be distributed by using several namespaces, but a single namespace/queue is intentionally concentrated in one Cluster slot. Redis Cluster script calls must pass only keys from one layout.

The layout includes job hashes, attempt lists, monotonic sequences, identity waiting/delayed indexes, active leases, queue controls, wake versions, counters, idempotency mappings, listing indexes, and a layout marker. The marker records adapter, protocol, layout, index-configuration, and script-set versions. Existing data with no marker or incompatible values fails with `RedisLayoutMismatchError`; the adapter never deletes or rewrites data automatically. Initial marker creation takes a short namespaced Redis lock and rechecks the marker while the lock is held; deployments should use this adapter (or otherwise coordinate writers) during first namespace initialization. Set `validateLayout: false` only when that check is deliberately managed elsewhere. The JobStore descriptor reports protocol v1, layout `1`, and the capability matrix in the core [compatibility policy](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-mq/docs/protocol/compatibility-v1.md).

## Codecs

`encodeJobRecord` and `encodeAttempt` validate before encoding. JSON values are canonical, cycle-free, plain data, and do not execute accessors. `decodeJobRecord` and `decodeAttempt` return `better-result` `Result` values and turn malformed hash fields or JSON into focused `RedisLayoutError` values without including payload or failure contents in default messages.

## Lua scripts

The package ships the foundation scripts in its tarball under `dist/scripts`. Startup loads every script with `SCRIPT LOAD`, stores its SHA, and runs operations through `EVALSHA`. A `NOSCRIPT` response reloads only the named script and retries once; there is no permanent `EVAL` fallback. Script arguments are split into `KEYS` and `ARGV`, and the planned transition scripts receive all timestamps from callers rather than querying Redis server time.

The wake channel is `<prefix>:{<namespace>}:wake`; its future messages contain only a queue and persisted wake version. Pub/Sub is an optimization, not the source of truth. Polling and persisted versions remain authoritative for lost notifications.

## Valkey and operations

Valkey is supported when it implements the Redis commands and Lua behavior used by this adapter. Test the exact server/client pair used in production. Redis persistence, replication, `maxmemory`/eviction policy, failover, and Cluster deployment remain operational responsibilities; MQ namespaces should not use an eviction policy that can discard durable jobs.

Metadata filtering is a residual first-version operation rather than a secondary Redis index; the descriptor therefore reports `metadataIndex: 'none'`. Prefer PostgreSQL for join-heavy or metadata-intensive queries. Destructive namespace flush helpers are not part of this public package.

## Development

```sh
bun run check
```

The package uses `bun:test`, TypeScript, Oxfmt, Oxlint, and `tsdown`. Redis integration tests run only when a test server is explicitly configured; the core package remains usable without the optional Redis peer.
