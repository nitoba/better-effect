# layer-scoped-providers Specification

## Purpose

Provides a type-safe Layer constructor for resource-owning Services whose acquisition depends on contextual Services and whose cleanup belongs to the Runtime root lifetime.

## Requirements

### Requirement: Scoped generator providers acquire from contextual dependencies

The Layer API MUST expose `Layer.scopedGen(Service, factory, release)`. Its factory MUST support the same contextual Service access as `Layer.gen`, and the produced instance MUST be registered for the requested Service token.

#### Scenario: Factory resolves a dependency

- **WHEN** a `Layer.scopedGen` factory yields a Service supplied by the same complete Layer
- **THEN** resolving the scoped provider MUST construct it with that contextual dependency

#### Scenario: Provider remains lazy

- **WHEN** a Runtime is built with a `Layer.scopedGen` provider that is never resolved
- **THEN** its factory and release callback MUST NOT run

### Requirement: Scoped generator resources belong to the Runtime root Scope

A successfully acquired `Layer.scopedGen` instance MUST remain alive across execution Scopes and MUST be released by the Runtime root Scope rather than by the DI backend or the execution that first resolves it.

#### Scenario: Resource survives multiple executions

- **WHEN** multiple Runtime executions resolve the same cached `Layer.scopedGen` Service
- **THEN** they MUST observe the same backend-cached instance and its release callback MUST not run between executions

#### Scenario: Runtime disposal releases the resource

- **WHEN** the Runtime root Scope closes after the scoped generator instance was acquired
- **THEN** its release callback MUST run exactly once before backend disposal

#### Scenario: Failed acquisition is not released

- **WHEN** the scoped generator factory throws or rejects before returning an instance
- **THEN** no release callback MUST be registered for that failed acquisition

### Requirement: Scoped generator cleanup is outcome-aware

The `Layer.scopedGen` release callback MUST receive the acquired Service instance and the `ScopeOutcome` chosen for the Runtime root Scope. Existing root cleanup aggregation, diagnostic, and failure-precedence rules MUST apply to release failures.

#### Scenario: Long-lived Runtime closes with success

- **WHEN** a long-lived Runtime is disposed normally after acquiring a scoped generator instance
- **THEN** its release callback MUST receive the instance and a success outcome

#### Scenario: One-shot Runtime propagates the final outcome

- **WHEN** a one-shot Runtime closes its root Scope after the program's final result is classified
- **THEN** the scoped generator release callback MUST receive that final root outcome

#### Scenario: Release failure uses existing shutdown semantics

- **WHEN** a scoped generator release callback fails during root closure
- **THEN** remaining root finalizers and backend disposal MUST still run and the failure MUST participate in the existing Runtime shutdown aggregation and precedence rules

### Requirement: Dependent root resources close in safe order

When a `Layer.scopedGen` provider acquires another root-scoped Service, root Scope LIFO semantics MUST release the dependent provider before the dependency it used during acquisition.

#### Scenario: Consumer releases before dependency

- **WHEN** scoped provider A is acquired by yielding scoped provider B
- **THEN** Runtime disposal MUST release A before B
