import { isClassInstanceValue } from './internal/instance.js'
import { isGenericClassValue, isGenericInstance } from './internal/generic-descriptor.js'

/** Returns whether a value is an instance created by a schema class. */
export const isClassInstance = (value: unknown): value is object =>
  isGenericClassValue(value) ? isGenericInstance(value) : isClassInstanceValue(value)
