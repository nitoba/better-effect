import { isClassInstanceValue } from "./internal/instance.js"

/** Returns whether a value is an instance created by a schema class. */
export const isClassInstance = (value: unknown): value is object =>
  isClassInstanceValue(value)
