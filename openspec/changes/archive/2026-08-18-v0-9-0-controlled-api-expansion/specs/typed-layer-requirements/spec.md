## MODIFIED Requirements

### Requirement: Effects use tagged Service instance requirements

The canonical public program type MUST be `Effect<A, E, R extends Service.Any = never>`, where `R` is a union of tagged Service instances. The type MUST remain a type-only facade over `better-result` and MUST add no runtime Effect representation. Every Effect combinator that returns an Effect MUST preserve the input requirement union or union it with the requirements of every Effect it can evaluate.

#### Scenario: Direct and returned requirements are combined

- **WHEN** a generator yields Database and returns an Effect requiring Logger
- **THEN** the result MUST be `Effect<A, E, Database | Logger>`

#### Scenario: Ordinary Results add no requirements

- **WHEN** a generator returns a plain `better-result` Result and yields no Service
- **THEN** `Effect.Requirements` MUST be `never`

#### Scenario: Mapping preserves requirements

- **WHEN** `Effect<A, E1, Database>` is mapped to another success type
- **THEN** the result MUST retain `Database` as its exact requirement channel

#### Scenario: Chaining unions requirements and errors

- **WHEN** `Effect<A, E1, Database>` is chained to an Effect requiring Cache and returning `B` with error `E2`
- **THEN** the result MUST be `Effect<B, E1 | E2, Database | Cache>`

#### Scenario: Collection combinators union every input

- **WHEN** `Effect.all` or `Effect.zip` combines Effects requiring Database and Cache
- **THEN** the output MUST retain the union `Database | Cache` and MUST NOT widen it to `Service.Any`

#### Scenario: Lazy Program collection preserves requirements

- **WHEN** `Program.all` combines Programs requiring Database and Cache
- **THEN** the returned Program MUST expose `Database | Cache` as its final requirement channel

