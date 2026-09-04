# Capabilities v1

`JobStoreCapabilities` is immutable, declarative metadata. It describes an
optional optimization or extension; it never weakens the correctness contract
of a mandatory operation. The only protocol-v1 capability names are:

- `queueFilteredNotifications: boolean` — wake delivery can honor the
  requested queue set. A false value means that polling or spurious wake-ups
  are allowed, not that `awaitWake` is unavailable.
- `nativeBatchEnqueue: boolean` — the adapter has a native implementation for
  bounded `enqueueMany` batches.
- `nativeBatchClaim: boolean` — the adapter can reserve a requested claim batch
  in its native atomic path.
- `metadataIndex: 'none' | 'residual' | 'indexed'` — metadata filtering is
  supported with no dedicated index, with a residual/backend scan, or with a
  dedicated index. The portable filter semantics are the same at every level.
- `transactionalEnqueue: boolean` — the adapter can make the complete
  `enqueueMany` request one transaction. When false, bounded chunks remain
  independently atomic and a later failure may leave an earlier chunk applied.
- `durableChangeFeed: boolean` — the adapter exposes a durable change-feed
  extension in addition to the required wake token/version.
- `globalConcurrency: boolean` — the adapter implements a durable concurrency
  limit spanning queues or workers.
- `rateLimiting: boolean` — the adapter implements a durable rate-limit
  extension.

The old names `notifications`, `batchClaim`, and `changeFeed` are not part of
protocol v1. Notification delivery is an implementation detail of
`awaitWake`; its persisted token/version remains authoritative. Signals may be
omitted, duplicated, delayed, or spurious. A notification payload must be
bounded and must not contain a job payload, metadata, idempotency key, lease
token, or arbitrary failure cause.

## Adapter matrix

This is the capability matrix for the adapters shipped with this repository,
with explicit roadmap placeholders for the adapters outside the current release.
It is not a promise about unlisted adapters.

| Adapter               | queueFilteredNotifications | nativeBatchEnqueue | nativeBatchClaim | metadataIndex | transactionalEnqueue | durableChangeFeed | globalConcurrency | rateLimiting |
| --------------------- | -------------------------: | -----------------: | ---------------: | ------------- | -------------------: | ----------------: | ----------------: | -----------: |
| `MemoryJobStore`      |                       true |              false |             true | `none`        |                false |             false |             false |        false |
| PostgreSQL (LISTEN)   |                       true |               true |             true | `indexed`     |                 true |             false |             false |        false |
| Redis/Valkey          |                       true |               true |             true | `none`        |                false |             false |             false |        false |
| MySQL (not shipped)   |                          — |                  — |                — | —             |                    — |                 — |                 — |            — |
| SQLite (not shipped)  |                          — |                  — |                — | —             |                    — |                 — |                 — |            — |
| MongoDB (not shipped) |                          — |                  — |                — | —             |                    — |                 — |                 — |            — |

Rows marked `not shipped` are roadmap placeholders, not capability claims;
those adapters are outside this repository's current release.

PostgreSQL reports `queueFilteredNotifications: true` only after it reserves
and attaches its LISTEN connection. Pool configurations that cannot reserve a
listener, including polling/PGlite test setups, report `false`; polling remains
correct in that mode.

A driver must publish one descriptor for the configured adapter and keep the
same capability value for the lifetime of that store. Descriptors and their
nested capability objects must be frozen. The Worker and the conformance kit
validate the descriptor before using the store.

Capability declarations are not feature negotiation. A consumer may use a
capability as a performance choice, but must retain a correct fallback when it
is false. `jobStoreContract` runs capability-gated scenarios only for declared
features and reports skipped coverage; it always runs mandatory correctness
scenarios. The conformance options should list every capability explicitly,
including `false` values, so the descriptor declaration is measured rather
than silently defaulted. `report().capabilitiesNotTested` contains only
capabilities declared `true` for which no executable scenario is registered;
a false capability is an intentional, verified absence of that extension.
The three extension flags above have no protocol-v1 operation surface. An
adapter that sets one to `true` must provide its separate extension
Service/interface and an adapter-specific `extensions` scenario; it must not
add an optional method to `JobStore`.
