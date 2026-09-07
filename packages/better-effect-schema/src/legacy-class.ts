import type * as z from 'zod'

import { createClass } from './internal/factory.js'
import type {
  ClassAnnotations,
  ClassBuilder,
  ClassDefinition,
  ClassFactory,
  RawShape
} from './types.js'

const makeClass = <Self>(identifier: string, annotations?: ClassAnnotations): ClassBuilder<Self> =>
  (<Definition extends RawShape | ClassDefinition>(definition: Definition) =>
    createClass<
      Self,
      Definition extends ClassDefinition ? Definition : z.ZodObject<Extract<Definition, RawShape>>
    >({
      identifier,
      definition,
      ...(annotations === undefined ? {} : { annotations })
    })) as ClassBuilder<Self>

/** Legacy provider-specific class entry retained for the deprecated facade. */
export const LegacyClass = makeClass as unknown as ClassFactory
