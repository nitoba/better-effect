# Compatibility v1

## Independent version axes

`protocolVersion` is `1` for the persisted JobStore contract. It is independent
of the npm package version and of an adapter's `layoutVersion` or migration
version. The public descriptor reports all of them together:

```ts
type JobStoreDescriptor = {
  readonly protocolVersion: 1
  readonly adapter: string
  readonly adapterVersion: string
  readonly layoutVersion: number | string
  readonly capabilities: JobStoreCapabilities
}
```

The descriptor and its nested `capabilities` object are immutable (drivers must
freeze them). `adapter` and `adapterVersion` identify the implementation;
`layoutVersion` identifies its persisted schema/index/script layout. A layout
mismatch is an adapter migration error, not a protocol mismatch.

## Startup handshake

Before a Worker starts supervision, it resolves every JobStore token used by its
handlers and validates the descriptor. Protocol v1 accepts only a complete,
immutable descriptor whose `protocolVersion` is exactly `1`. A missing,
malformed, mutable, or different protocol descriptor fails with
`JobStoreProtocolMismatchError`; the Worker must not start polling or claim a
job. The handshake does not inspect a pool, client, private key, table, or
migration implementation.

The conformance kit performs the same check and records the first descriptor in
its report. All runtimes opened by one suite must report the same adapter,
adapter version, layout version, protocol version, and capabilities.

## Breaking changes and migrations

A change to persisted field meaning, state semantics, transition preconditions,
claim/list ordering, time or lease rules, failure representation, or required
operation behavior is a protocol break and requires a new protocol version,
coordinated adapter releases, and release notes. A backward-compatible field or
operation addition may remain in v1 only when existing records and v1 adapters
retain their meaning. Unknown persisted fields must not be silently interpreted
as known fields.

Adapter migrations are independent and forward-only. An adapter must validate
its layout before serving requests and must reject a newer or incompatible
layout; it must not silently downgrade, delete, or rewrite existing data. Use an
expand/migrate/contract rollout for destructive changes and document manual
recovery separately.

## npm and deployment policy

The current packages support protocol v1 and the following package ranges:

- `better-effect-mq`: `0.1.x`;
- `better-effect-mq-postgres`: `0.1.x`;
- `better-effect-mq-redis`: `0.1.x`.

The package ranges are release policy, not a substitute for the descriptor
handshake. `better-effect-mq` is pre-1.0, so a minor release may contain a
source/API break under the project's 0.x policy; it still must not silently
change the meaning of persisted v1 data. After 1.0, normal semver applies to
public TypeScript/runtime APIs, while protocol breaks still require a new
protocol version and an explicitly coordinated migration.

There is no automatic v0-to-v1 upcaster or definition registry. A rolling
deployment must keep the old and new adapter versions able to interpret the
same records, or use a separately migrated namespace. A v2 implementation may
coexist in a different store/namespace, but v1 has no implicit negotiation or
fallback: a consumer must explicitly select and validate the protocol it
supports. Never treat a future protocol as v1 merely because its fields look
similar.
