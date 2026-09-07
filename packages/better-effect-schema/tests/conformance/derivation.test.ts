import { describe, expect, test } from 'bun:test'
import * as v from 'valibot'
import * as z from 'zod'
import { type as arkType } from 'arktype'

import {
  Schema,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../../dist/esm/index.js'
import { ArkTypeAdapter } from '../../dist/esm/arktype.js'
import { ValibotAdapter } from '../../dist/esm/valibot.js'
import { ZodAdapter } from '../../dist/esm/zod.js'
import { expectFailure, noThrowSync, standardSchema, unwrapOk } from './helpers.js'

const invoke = (facade: object, method: string, args: readonly unknown[]): unknown => {
  const operation = Reflect.get(facade, method)
  if (typeof operation !== 'function') throw new Error(`Missing facade method: ${method}`)
  return Reflect.apply(operation, facade, args)
}

describe('structural derivations preserve provider semantics', () => {
  test('Zod preserves object behavior, fields, and source immutability', () => {
    const source = z.object({
      id: z.string(),
      count: z.number(),
      nested: z.object({ enabled: z.boolean() })
    })
    const local = Schema.with(ZodAdapter)
    const before = Object.keys(source.shape)

    const picked = unwrapOk(
      noThrowSync(() => invoke(local, 'derive', [source, 'pick', { id: true }]))
    )
    const partial = unwrapOk(noThrowSync(() => invoke(local, 'derive', [source, 'partial'])))
    const deep = unwrapOk(noThrowSync(() => invoke(local, 'derive', [source, 'deepPartial'])))
    const strict = unwrapOk(noThrowSync(() => invoke(local, 'policy', [source, 'strict'])))

    expect(picked.parse({ id: 'one' })).toEqual({ id: 'one' })
    expect(partial.parse({})).toEqual({})
    expect(deep.parse({ nested: {} })).toEqual({ nested: {} })
    expect(
      strict.safeParse({ id: 'one', count: 1, nested: { enabled: true }, extra: true }).success
    ).toBe(false)
    expect(Object.keys(source.shape)).toEqual(before)
  })

  test('Valibot preserves exact missing-vs-undefined and nested deep partial behavior', () => {
    const source = v.object({
      id: v.string(),
      nested: v.object({ count: v.number() })
    })
    const local = Schema.with(ValibotAdapter)
    const exact = unwrapOk(noThrowSync(() => invoke(local, 'derive', [source, 'exactPartial'])))
    const deep = unwrapOk(noThrowSync(() => invoke(local, 'derive', [source, 'deepPartial'])))

    const missing = source['~standard'].validate({ id: undefined, nested: { count: 1 } })
    const exactValid = exact['~standard'].validate({ nested: { count: 1 } })
    const deepValid = deep['~standard'].validate({ nested: {} })

    expect(Reflect.get(missing as object, 'issues')).toBeDefined()
    expect(Reflect.get(exactValid as object, 'issues')).toBeUndefined()
    expect(Reflect.get(deepValid as object, 'issues')).toBeUndefined()
  })

  test('ArkType exposes positive native derivations and explicit unsupported variants', () => {
    const source = arkType({ id: 'string', count: 'number' })
    const local = Schema.with(ArkTypeAdapter)

    const picked = unwrapOk(noThrowSync(() => invoke(local, 'derive', [source, 'pick', ['id']])))
    const extended = unwrapOk(
      noThrowSync(() => invoke(local, 'derive', [source, 'extend', { active: 'boolean' }]))
    )
    const exactPartial = noThrowSync(() => invoke(local, 'derive', [source, 'exactPartial']))
    const deepPartial = noThrowSync(() => invoke(local, 'derive', [source, 'deepPartial']))

    expect(picked({ id: 'one' }) instanceof arkType.errors).toBe(false)
    expect(extended({ id: 'one', count: 1, active: true }) instanceof arkType.errors).toBe(false)
    expectFailure(exactPartial as never, SchemaUnsupportedOperation)
    expectFailure(deepPartial as never, SchemaUnsupportedOperation)
  })

  test('invalid masks, protected keys, and root refinements fail explicitly', () => {
    const source = z.object({ id: z.string(), name: z.string() })
    const local = Schema.with(ZodAdapter)
    const missing = noThrowSync(() => invoke(local, 'derive', [source, 'pick', { missing: true }]))
    expectFailure(missing as never, SchemaDefinitionFailure)

    const refined = z
      .object({ id: z.string(), name: z.string() })
      .refine((value) => value.id !== 'blocked')
    const derived = noThrowSync(() => invoke(local, 'derive', [refined, 'pick', { id: true }]))
    expectFailure(derived as never, SchemaExecutionFailure)
  })

  test('rejects prototype-polluting masks without throwing', () => {
    const source = standardSchema(() => ({ value: { id: 'safe' } }))
    const mask = Object.create(null) as Record<string, boolean>
    Object.defineProperty(mask, '__proto__', { value: true, enumerable: true })
    const local = Schema.with(ZodAdapter)
    const result = noThrowSync(() => invoke(local, 'derive', [source, 'pick', mask]))
    expectFailure(result as never, SchemaUnsupportedOperation)
  })
})
