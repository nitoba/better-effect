/** Runtime marker shared across module reloads. */
export const INSTANCE_MARKER = Symbol.for("better-effect-schema/instance")

/** Type-only metadata carrier exposed by schema class constructors. */
export const CLASS_TYPE_ID: unique symbol = Symbol.for(
  "better-effect-schema/type"
) as never
