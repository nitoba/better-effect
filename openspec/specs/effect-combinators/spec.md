# effect-combinators Specification

## Purpose

Provides the Result-oriented Effect helpers needed for larger workflows while
keeping the library's declaration-only Service requirement channel precise.

## Requirements

### Requirement: Effect observation helpers preserve the original result

The `Effect` namespace MUST expose `tap`, `tapError`, and `tapBoth`. Each helper MUST return the original success or error value unchanged, MUST invoke only the handler for the active branch, and MUST preserve the input's `Effect.Requirements` exactly. Handler failures MUST follow the existing `better-result` failure behavior.

#### Scenario: Tap observes a successful Effect

- **WHEN** `Effect.tap` is applied to an `Ok` Effect
- **THEN** the success value and its error and requirement channels MUST be unchanged, and the success handler MUST run once

#### Scenario: TapError observes an error Effect

- **WHEN** `Effect.tapError` is applied to an `Err` Effect
- **THEN** the error value and its success and requirement channels MUST be unchanged, and the error handler MUST run once

#### Scenario: TapBoth selects one branch

- **WHEN** `Effect.tapBoth` is applied to either an `Ok` or an `Err` Effect
- **THEN** exactly the matching handler MUST run and the other handler MUST NOT run

### Requirement: Effect recovery unions successful values and preserves requirements

The `Effect` namespace MUST expose synchronous `recover` and asynchronous `recoverAsync` operations. A recovery callback MUST run only for an error result and MUST return a Result-compatible Effect. The output success channel MUST include the original successful value and the recovery value where applicable, the output error channel MUST follow the recovery Effect's error channel, and the output requirements MUST be the union of the input and recovery requirements.

#### Scenario: Successful input bypasses recovery

- **WHEN** `Effect.recover` is applied to an `Ok` Effect
- **THEN** the recovery callback MUST NOT run and the original success MUST be returned

#### Scenario: Error input is recovered

- **WHEN** `Effect.recover` is applied to an `Err` Effect and the callback returns `Ok(fallback)`
- **THEN** the result MUST be `Ok(fallback)` with the callback's requirements included in the static requirement union

#### Scenario: Asynchronous recovery preserves channels

- **WHEN** `Effect.recoverAsync` handles an error with a Promise of an Effect
- **THEN** it MUST await that Effect and expose the same success, error, and requirement rules as `recover`

### Requirement: Effect value transformations retain error and requirement channels

The `Effect` namespace MUST expose `flatten`, `as`, and `asVoid`. `flatten` MUST remove one nested Effect layer and union outer and inner error and requirement channels. `as` MUST replace only a successful value, and `asVoid` MUST replace a successful value with `void`; both MUST preserve the existing error and requirement channels.

#### Scenario: Flatten combines nested channels

- **WHEN** an `Effect` succeeds with an inner `Effect<B, E2, R2>` while carrying outer channels `E1` and `R1`
- **THEN** `Effect.flatten` MUST produce `Effect<B, E1 | E2, R1 | R2>`

#### Scenario: As replaces only success

- **WHEN** `Effect.as(effect, replacement)` is applied
- **THEN** an `Ok` MUST contain `replacement`, while an `Err` and the input requirement union MUST remain unchanged

#### Scenario: AsVoid discards success data

- **WHEN** `Effect.asVoid` is applied to a successful Effect
- **THEN** it MUST produce an `Ok<void>` and MUST preserve the input error and requirement channels

### Requirement: Effect matching is branch-safe and requirement-aware

The `Effect` namespace MUST expose `match` with handlers for both success and error branches. Matching to plain values MUST follow the underlying Result semantics. When handlers return Effects, the resulting Effect MUST union both handler error channels and all input and handler requirement channels.

#### Scenario: Plain match returns the selected branch value

- **WHEN** `Effect.match` receives an `Ok` or `Err` and both handlers return the same plain value type
- **THEN** only the selected handler MUST run and that plain value MUST be returned

#### Scenario: Effect-valued match unions requirements

- **WHEN** either match handler returns an Effect requiring a different Service
- **THEN** the resulting Effect MUST include the input requirement and both handler requirement unions, without evaluating the unselected handler

### Requirement: Effect collections preserve order and type unions

The `Effect` namespace MUST expose `all` and `zip` for already-created Result-compatible Effects. `all` MUST collect successful values in input order and short-circuit according to the underlying Result collection semantics. `zip` MUST return the ordered pair. Both operations MUST union every input error and Service requirement channel, and MUST NOT accept a lazy Program as a substitute for an Effect.

#### Scenario: All collects a heterogeneous tuple

- **WHEN** `Effect.all` receives successful Effects requiring Database and Cache
- **THEN** it MUST return the tuple in input order with error type union and requirement type `Database | Cache`

#### Scenario: All returns an error without changing its value

- **WHEN** one input to `Effect.all` is an `Err`
- **THEN** the returned error MUST follow `better-result` collection ordering and no later success value MUST be fabricated

#### Scenario: Zip returns two values

- **WHEN** `Effect.zip` receives two successful Effects
- **THEN** it MUST return `[left, right]` with the union of both error and requirement channels
