# Capability-based derivation

Structural derivation is implemented by the provider-neutral engine under
`src/derivation/`. The engine validates masks, protected keys, identifiers, and
provider results. It does not inspect a provider AST or rebuild a schema from
its fields.

## Capability boundary

An adapter opts into structural derivation with the declared `derivation.derive`
capability. Object policies use the separate `structure.policy` capability.
Missing capabilities return `SchemaUnsupportedOperation`. A capability that
throws, rejects, returns a thenable to a synchronous call, or returns a value
other than a `Result` is reported as a typed execution/async/definition failure.
There is no permissive schema fallback.

The request passed to `derive` contains the operation, a frozen field/mask
snapshot when introspection is required, the selected keys, protected keys, and
the operation-specific partial mode. It also carries a validated derived-schema
identifier, including the identifier requested by `extend`. The provider owns the native translation
and therefore owns preservation of refinements, defaults, codecs, and unknown
property policy. A provider must report unsupported when its native operation
cannot preserve those contracts.

## Protected fields and masks

Protected fields are never included in an extension, omit mask, partial mask, or
required mask. `pick` may select a protected field, and always adds existing
protected fields to its selected keys. The engine validates every mask key against the declared field capability and
accepts symbol keys as well as dangerous names such as `__proto__` and
`constructor` without assigning through a normal object prototype.

Input masks and augmentation maps are copied into frozen, null-prototype
records. The original schema, field map, mask, and metadata are not mutated.

## Partial and recursive schemas

An omitted `catchall` is a definition failure, while an explicitly supplied
`undefined` catchall is passed to the declared provider. `partial` carries `partialMode: "optional"`; `exactPartial` carries
`partialMode: "exactOptional"`. The distinction is intentional: the adapter
must preserve whether an omitted property differs from a property explicitly
set to `undefined`. `required` is dispatched independently and does not infer
semantics by wrapping fields.

`deepPartial` receives an identity memo and a recursive dispatch context. The
engine caches completed derivations by schema identity. A provider that calls
back into the context for a schema already active in the current derivation
gets a typed `SchemaUnsupportedOperation` result, preventing unbounded
recursion. Providers that cannot represent a recursive result should propagate
that result rather than walking user values or throwing.

Whole-object codecs and object refinements are therefore safe only when the
adapter explicitly declares a preserving capability. Equal-looking provider
method names do not opt an operation in.
