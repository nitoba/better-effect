## Purpose

Provides small, optional contextual Services and deterministic test layers for
cross-cutting concerns without placing product-specific infrastructure in core.

## ADDED Requirements

### Requirement: Standard Services are optional normal Services

Clock, Random, Logger, CurrentRequest, and CurrentAbortSignal MUST be exposed as optional modules that use the existing Service/Layer and Runtime context contracts. Importing the core package MUST NOT install any of them automatically, and applications MUST be able to replace each with a test or application layer.

#### Scenario: No standard provider is implicit

- **WHEN** an application imports a standard-service module without composing its layer
- **THEN** resolving that Service MUST behave like any other missing provider and MUST NOT create a hidden global singleton

#### Scenario: A standard Service can be overridden

- **WHEN** an application composes a test implementation for Clock, Random, or Logger
- **THEN** the Runtime MUST resolve the replacement through the normal Layer override rules

### Requirement: Clock has deterministic test behavior

The Clock module MUST provide a production implementation backed by the host time source and a `ClockTest` implementation whose current time and waiting behavior are explicitly controlled by the test. The two implementations MUST share the same Service contract.

#### Scenario: ClockTest controls observed time

- **WHEN** a program runs with `ClockTest` configured to a fixed instant
- **THEN** every Clock read in that execution MUST return the configured instant until the test changes it

### Requirement: Random has reproducible seeded behavior

The Random module MUST provide a production implementation and a `RandomSeeded` implementation. Reusing the same seed MUST produce the same observable sequence, while separate Runtime executions MUST not share mutable generator state unless the seeded layer is intentionally shared.

#### Scenario: The same seed repeats a sequence

- **WHEN** two executions use equivalent `RandomSeeded` layers with the same seed
- **THEN** corresponding random draws MUST be equal and draw order MUST be preserved

### Requirement: Logger supports a test capture implementation

The Logger module MUST provide a production implementation and a `LoggerTest` implementation that records structured log events in order. Logging MUST remain an explicit Service call and MUST NOT alter the success or error value of the calling Effect when the logger succeeds.

#### Scenario: LoggerTest captures events

- **WHEN** a program emits two log events through `LoggerTest`
- **THEN** the test implementation MUST expose both events in emission order with their level and message data

### Requirement: Request and abort context remain execution-local

CurrentRequest and CurrentAbortSignal MUST observe only the values associated with the active Runtime execution. Nested or concurrent executions MUST be isolated, and the abort-signal bridge MUST retain the existing behavior for an execution without a caller signal.

#### Scenario: Concurrent requests do not cross-contaminate

- **WHEN** two concurrent Runtime executions provide different CurrentRequest values
- **THEN** each execution MUST observe only its own request value

#### Scenario: CurrentAbortSignal remains available without a caller signal

- **WHEN** a program yields CurrentAbortSignal in a Runtime run with no caller-provided signal
- **THEN** it MUST receive the existing non-aborted fallback signal

