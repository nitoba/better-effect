## MODIFIED Requirements

### Requirement: Standard Services are optional normal Services

Clock, Random, Logger, Config, CurrentRequest, and CurrentAbortSignal MUST be exposed as optional modules that use the existing Service/Layer and Runtime context contracts. Importing the core package MUST NOT install any of them automatically, and applications MUST be able to replace each with a test or application layer.

#### Scenario: No standard provider is implicit

- **WHEN** an application imports a standard-service module without composing its layer
- **THEN** resolving that Service MUST behave like any other missing provider and MUST NOT create a hidden global singleton

#### Scenario: A standard Service can be overridden

- **WHEN** an application composes a test implementation for Clock, Random, Logger, or Config
- **THEN** the Runtime MUST resolve the replacement through the normal Layer override rules
