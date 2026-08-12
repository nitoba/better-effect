## 1. Prove the tagged type model

- [x] 1.1 Add an isolated type experiment for
      `Service<Database>()('Database')` proving
      `yield* Database` infers exactly `Database`.
- [x] 1.2 Prove that `EffectRequirements` carries
      `ServiceToken<'Database', Database>` and rejects widened `string` and empty
      Service tags.
- [x] 1.3 Record the supported TypeScript inference shape before migrating
      repository declarations.

## 2. Refactor Service identity types

- [x] 2.1 Replace the untagged self-type `Service<Self>()` factory with the
      literal-tag `Service<Self>()('Tag')` factory and self-capturing static
      iterator.
- [x] 2.2 Define tag-aware `ServiceToken`, `AnyServiceToken`, `ServiceClass`,
      `ServiceInstance`, and internal tag projections without instance-derived
      identity.
- [x] 2.3 Preserve `ServiceRuntime.resolve`'s token-to-instance relationship
      and update diagnostics to include the Service tag.
- [x] 2.4 Update Service runtime and type tests, including literal tags,
      exact yield types, resolver return types, invalid tags, and structural mocks.

## 3. Preserve tagged requirement metadata

- [x] 3.1 Update `ServiceRequirement` and Effect requirement extraction to carry
      tag-aware self-bound constructor contracts such as
      `ServiceToken<'Database', Database>`.
- [x] 3.2 Implement internal tag and bidirectional contract compatibility
      predicates for requirement matching.
- [x] 3.3 Update Effect generator, pipeline, `ServiceRequirements`, and
      acquire/release type tests to assert exact tagged contract unions.

## 4. Update Layer type inference and composition

- [x] 4.1 Refactor missing-Service and completeness calculations to use tagged
      identity plus contract compatibility.
- [x] 4.2 Update `Layer.override` type calculations so compatible replacements
      remove obsolete specs and incompatible same-tag replacements retain a clear
      diagnostic or are rejected.
- [x] 4.3 Add type tests for different-tag identical shapes, same-tag compatible
      contracts, same-tag incompatible contracts, LayerMissing, Layer.gen, and
      Layer.scopedGen.
- [x] 4.4 Preserve structural `Layer.make`, `Layer.succeed`, and scoped provider
      creation boundaries without requiring tags on implementations.

## 5. Align runtime Layer identity and backends

- [x] 5.1 Change Layer merge and override provider maps to use Service tags and
      report duplicate/collision diagnostics with the tag.
- [x] 5.2 Retain registering constructors with providers and prevent an
      incompatible same-tag association from being silently resolved.
- [x] 5.3 Migrate `MemoryLayerBackend` provider, instance, and pending maps to
      tag keys while preserving lazy acquisition, caching, and disposal.
- [x] 5.4 Migrate `ItiLayerBackend` to deterministic tag-based keys and tag
      duplicate detection without leaking ITI details into core APIs.
- [x] 5.5 Add runtime tests for different-tag isolation, duplicate merge,
      compatible override, incompatible collision, missing tags, caching,
      concurrent runtimes, and scoped cleanup.

## 6. Migrate repository consumers

- [x] 6.1 Migrate every Service declaration in `src`, tests, type tests, and the
      TODO API example to `Service<Self>()('Name')`.
- [x] 6.2 Replace all instance-derived `ServiceToken<...>` assertions with
      exact tag-aware self-bound contract assertions and update public API tests.
- [x] 6.3 Update README examples and explanations for stable tags, different-tag
      structural Services, overrides, and optional namespaced tags.
- [x] 6.4 Update AGENTS.md invariants so tag identity, exact requirements, and
      backend behavior are the documented architecture.
- [x] 6.5 Review package exports and preserve only genuinely useful public tag
      helpers; do not expose internal comparison predicates.

## 7. Verify release readiness

- [x] 7.1 Run `bun run typecheck` and all runtime/type tests.
- [x] 7.2 Run `bun run lint`, `bun run format:check`, `bun run build`, and
      `bun run publint`.
- [x] 7.3 Verify the `check` script's formatting step does not mutate files and
      run `bun run check` when corrected if necessary.
- [x] 7.4 Run `bun pm pack --dry-run` and inspect the package contents.
- [x] 7.5 Record breaking changes, collision semantics, internal casts, and
      quality-gate results before any release/version bump or publication.
