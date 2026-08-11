## 1. Public API and Internal Provider Contract

- [x] 1.1 Add `Layer.scopedGen(Service, factory, release)` using the existing generator factory and requirement types, with exact Service-instance and `ScopeOutcome` release parameters.
- [x] 1.2 Extend the erased `LayerProvider.release` contract to carry `ScopeOutcome`, adapt `Layer.scoped` without changing its public signature, and keep casts localized to Layer construction.
- [x] 1.3 Forward the root Scope outcome through `bindProviderToScope` while preserving immediate cleanup when acquisition races with root closure.

## 2. Runtime Lifecycle Coverage

- [x] 2.1 Add runtime tests proving scoped generator acquisition resolves contextual dependencies lazily and caches the produced instance across executions.
- [x] 2.2 Add tests proving successful instances release exactly once before backend disposal, failed acquisitions do not release, and long-lived versus one-shot root outcomes reach the release callback.
- [x] 2.3 Add tests proving dependent scoped providers release in LIFO dependency-safe order and release failures retain existing shutdown aggregation, observer, and precedence semantics.

## 3. Type Contracts

- [x] 3.1 Add compile-time tests for the exact provided/required Service-token unions inferred from `Layer.scopedGen`.
- [x] 3.2 Add compile-time acceptance and rejection tests for complete and incomplete Layer compositions using scoped generator dependencies.
- [x] 3.3 Add callback inference tests for the exact Service instance and `ScopeOutcome` parameters, invalid factory return values, and unchanged `Layer.scoped` compatibility.

## 4. Documentation and Validation

- [x] 4.1 Document `Layer.scopedGen` in README and AGENTS with a real dependency-owning resource example, ownership rules, and its distinction from `Layer.gen` and `Layer.scoped`.
- [x] 4.2 Review the TODO API example and update it only if a genuine scoped provider dependency exists; do not introduce a fake resource or no-op release solely to demonstrate the API.
- [x] 4.3 Run focused Layer/runtime/type tests, `bun run check`, and `bun pm pack --dry-run`.
