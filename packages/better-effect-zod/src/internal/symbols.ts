/** Runtime marker shared across module reloads. */
export const INSTANCE_MARKER = Symbol.for("better-effect-zod/instance")

/** Type-only metadata carrier exposed by schema class constructors. */
export const CLASS_TYPE_ID: unique symbol = Symbol.for(
  "better-effect-zod/type"
) as never
