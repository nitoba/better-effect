import type * as z from 'zod'
import type { ClassDefinition, DefinitionFields } from './common.js'

export interface ClassTypeMetadata<
  Self,
  Definition extends ClassDefinition,
  ConstructorProps,
  InstanceProps,
  Inherited = object,
  ProtectedKeys extends PropertyKey = never,
  Fields = DefinitionFields<Definition>
> {
  readonly self: Self
  readonly definition: Definition
  /** @deprecated Internal type alias retained for backwards compatibility. */
  readonly schema: Definition
  readonly fields: Fields
  readonly props: ConstructorProps
  readonly instanceProps: InstanceProps
  readonly inherited: Inherited
  readonly protectedKeys: ProtectedKeys
  readonly encoded: z.input<Definition>
}
