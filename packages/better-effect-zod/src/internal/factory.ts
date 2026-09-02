import type * as z from "zod"

import type {
  AnyObjectSchema,
  ClassDefinition,
  DefinitionFields,
  SchemaClass
} from "../types.js"
import { installDerivationApi } from "./class-derivation-api.js"
import { installSchemaApi } from "./class-schema-api.js"
import type {
  CreateClassOptions,
  RuntimeSchemaClass
} from "./class-types.js"
import {
  registerDescriptor,
  type ClassDescriptor
} from "./descriptor.js"
import {
  defaultMetadata,
  initializeMetadata
} from "./metadata.js"
import { resolveClassDefinition } from "./object-schema.js"
import { createSchemaFacade } from "./proxy.js"
import { createRuntimeClass } from "./runtime-class.js"
import { validateClassIdentifier } from "./derivation.js"

export type { CreateClassOptions } from "./class-types.js"

export function createClass<
  Self,
  Definition extends ClassDefinition,
  ConstructorProps = z.output<Definition>,
  InstanceProps = z.output<Definition>,
  Inherited = object,
  ProtectedKeys extends PropertyKey = never
>(options: CreateClassOptions): SchemaClass<
  Self,
  Definition,
  ConstructorProps,
  InstanceProps,
  Inherited,
  ProtectedKeys,
  DefinitionFields<Definition>
> {
  validateClassIdentifier(options.identifier)

  const resolved = resolveClassDefinition(options.definition)
  const descriptor: ClassDescriptor = Object.freeze({
    identifier: options.identifier,
    definition: resolved.definition,
    derivationStruct: resolved.derivationStruct,
    encodedSchema: resolved.encodedSchema,
    propsSchema: resolved.propsSchema,
    fields: resolved.fields,
    annotations: options.annotations,
    kind: options.kind ?? "class",
    tag: options.tag,
    protectedKeys: Object.freeze([...(options.protectedKeys ?? [])]),
    parent: options.parent
  })

  const runtimeClass = createRuntimeClass(options, descriptor)
  const createDerivedClass = (
    derivedOptions: CreateClassOptions
  ): RuntimeSchemaClass => createClass<unknown, AnyObjectSchema>(
    derivedOptions
  ) as unknown as RuntimeSchemaClass

  installDerivationApi(runtimeClass, createDerivedClass)
  installSchemaApi(runtimeClass)
  registerDescriptor(runtimeClass, descriptor)

  const facade = createSchemaFacade(runtimeClass)
  registerDescriptor(facade, descriptor)
  initializeMetadata(
    facade,
    defaultMetadata(descriptor.identifier, descriptor.annotations)
  )

  return facade as unknown as SchemaClass<
    Self,
    Definition,
    ConstructorProps,
    InstanceProps,
    Inherited,
    ProtectedKeys,
    DefinitionFields<Definition>
  >
}
