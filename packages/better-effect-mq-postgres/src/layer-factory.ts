// oxlint-disable anti-slop/no-runtime-typeof -- this boundary distinguishes a lazy generator from a configuration value.

import type { AnyService, ServiceRequirement } from 'better-effect'

/** A value factory accepted by contextual adapter Layer helpers. */
export type PostgresLayerValueFactory<Value> = () => Value | PromiseLike<Value>

/** A factory whose configuration may be assembled from contextual Services. */
export type PostgresLayerGenerator<Value, Yield extends ServiceRequirement<unknown>> = () =>
  | Generator<Yield, Value, unknown>
  | AsyncGenerator<Yield, Value, unknown>

export type PostgresLayerFactory<Value, Yield extends ServiceRequirement<unknown> = never> =
  | PostgresLayerValueFactory<Value>
  | PostgresLayerGenerator<Value, Yield>

/** Extract the Service instances represented by a contextual factory's yields. */
export type PostgresLayerRequirements<Yield extends ServiceRequirement<unknown>> =
  Yield extends ServiceRequirement<infer Requirement>
    ? Requirement extends AnyService
      ? Requirement
      : never
    : never

/** Preserve the exact Service requirement marker inferred from a generator factory. */
type PostgresLayerFactoryYield<Factory> = Factory extends () => Generator<
  infer Yield,
  unknown,
  unknown
>
  ? Yield
  : Factory extends () => AsyncGenerator<infer Yield, unknown, unknown>
    ? Yield
    : never

/** Preserve the exact Service requirements inferred from a generator factory. */
export type PostgresLayerFactoryRequirements<Factory> =
  PostgresLayerFactoryYield<Factory> extends ServiceRequirement<unknown>
    ? PostgresLayerRequirements<PostgresLayerFactoryYield<Factory>>
    : never

type PostgresLayerGeneratorResult<Value, Yield extends ServiceRequirement<unknown>> =
  | Generator<Yield, Value, unknown>
  | AsyncGenerator<Yield, Value, unknown>

const isGeneratorResult = <Value, Yield extends ServiceRequirement<unknown>>(
  value: Value | PromiseLike<Value> | PostgresLayerGeneratorResult<Value, Yield>
): value is PostgresLayerGeneratorResult<Value, Yield> =>
  typeof value === 'object' && value !== null && 'next' in value && typeof value.next === 'function'

/** Normalize value and generator factories to the Layer generator contract. */
export const normalizePostgresLayerFactory = <Value, Yield extends ServiceRequirement<unknown>>(
  factory: PostgresLayerFactory<Value, Yield>
): (() => AsyncGenerator<Yield, Value, unknown>) =>
  async function* () {
    const result = factory()

    if (isGeneratorResult(result)) {
      return yield* result
    }

    return await result
  }
