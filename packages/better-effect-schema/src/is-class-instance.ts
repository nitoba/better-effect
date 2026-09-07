import { isGenericInstance } from './internal/generic-descriptor.js'

/** Returns whether a value is an instance created by a schema class. */
export const isClassInstance = (value: unknown): value is object => isGenericInstance(value)
