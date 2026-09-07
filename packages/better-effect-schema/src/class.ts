import type * as z from "zod"

import { createClass } from "./internal/factory.js"
import type {
  ClassAnnotations,
  ClassBuilder,
  ClassDefinition,
  ClassFactory,
  RawShape
} from "./types.js"

const makeClass = <Self>(
  identifier: string,
  annotations?: ClassAnnotations
): ClassBuilder<Self> => {
  return (<Definition extends RawShape | ClassDefinition>(
    definition: Definition
  ) => createClass<Self, Definition extends ClassDefinition
    ? Definition
    : z.ZodObject<Extract<Definition, RawShape>>>({
      identifier,
      definition,
      ...(annotations === undefined ? {} : { annotations })
    })) as ClassBuilder<Self>
}

/**
 * Creates a class whose constructor validates decoded props and whose static
 * surface is a bidirectional Zod schema.
 */
export const Class = makeClass as unknown as ClassFactory
