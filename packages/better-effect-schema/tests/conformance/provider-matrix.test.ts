import { describe, expect, test } from 'bun:test'
import * as v from 'valibot'
import { type as arkType } from 'arktype'
import * as z from 'zod'
import { Result } from 'better-result'

import {
  Schema,
  SchemaAsyncRequired,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../../dist/esm/index.js'
import { ArkTypeAdapter } from '../../dist/esm/arktype.js'
import { ValibotAdapter } from '../../dist/esm/valibot.js'
import { ZodAdapter } from '../../dist/esm/zod.js'
import { expectFailure, noThrowSync, standardSchema, unwrapOk } from './helpers.js'

type CapabilityName =
  | 'read'
  | 'props'
  | 'make'
  | 'encoded'
  | 'encode'
  | 'encodeAsync'
  | 'fields'
  | 'struct'
  | 'policy'
  | 'derive'
  | 'toJSONSchema'
  | 'bridge'

type ProviderCase = {
  readonly name: string
  readonly adapter: object
  readonly schema: object
  readonly fields: readonly string[]
  readonly supported: readonly CapabilityName[]
  readonly unsupportedOperations: readonly {
    readonly method: CapabilityName
    readonly args: readonly unknown[]
    readonly failure: abstract new (...args: never[]) => unknown
  }[]
}

const allCapabilities: readonly CapabilityName[] = [
  'read',
  'props',
  'make',
  'encoded',
  'encode',
  'encodeAsync',
  'fields',
  'struct',
  'policy',
  'derive',
  'toJSONSchema',
  'bridge'
]

const capability = (value: object, name: CapabilityName): unknown => Reflect.get(value, name)

const invoke = (value: object, name: CapabilityName, args: readonly unknown[]): unknown => {
  const method = capability(value, name)
  if (typeof method !== 'function') throw new Error(`Capability ${name} is not installed`)
  return Reflect.apply(method, value, args)
}

const providerCases: readonly ProviderCase[] = [
  {
    name: 'zod',
    adapter: ZodAdapter,
    schema: z.object({ id: z.string(), count: z.number() }),
    fields: ['id', 'count'],
    supported: [
      'read',
      'props',
      'make',
      'encoded',
      'encode',
      'encodeAsync',
      'fields',
      'struct',
      'policy',
      'derive',
      'bridge'
    ],
    unsupportedOperations: [
      {
        method: 'toJSONSchema',
        args: [{ target: 'draft-2020-12' }],
        failure: SchemaUnsupportedOperation
      },
      { method: 'policy', args: [undefined, 'catchall'], failure: SchemaUnsupportedOperation }
    ]
  },
  {
    name: 'valibot',
    adapter: ValibotAdapter,
    schema: v.object({ id: v.string(), count: v.number() }),
    fields: ['id', 'count'],
    supported: [
      'read',
      'props',
      'make',
      'encoded',
      'fields',
      'struct',
      'policy',
      'derive',
      'bridge'
    ],
    unsupportedOperations: [
      {
        method: 'encode',
        args: [undefined, { id: 'value', count: 1 }],
        failure: SchemaUnsupportedOperation
      },
      {
        method: 'encodeAsync',
        args: [undefined, { id: 'value', count: 1 }],
        failure: SchemaUnsupportedOperation
      },
      {
        method: 'toJSONSchema',
        args: [{ target: 'draft-2020-12' }],
        failure: SchemaUnsupportedOperation
      },
      { method: 'policy', args: [undefined, 'catchall'], failure: SchemaUnsupportedOperation }
    ]
  },
  {
    name: 'arktype',
    adapter: ArkTypeAdapter,
    schema: arkType({ id: 'string', count: 'number' }),
    fields: ['id', 'count'],
    supported: [
      'read',
      'props',
      'make',
      'encoded',
      'fields',
      'struct',
      'policy',
      'derive',
      'bridge'
    ],
    unsupportedOperations: [
      {
        method: 'encode',
        args: [undefined, { id: 'value', count: 1 }],
        failure: SchemaUnsupportedOperation
      },
      {
        method: 'encodeAsync',
        args: [undefined, { id: 'value', count: 1 }],
        failure: SchemaUnsupportedOperation
      },
      {
        method: 'toJSONSchema',
        args: [{ target: 'draft-2020-12' }],
        failure: SchemaUnsupportedOperation
      },
      { method: 'derive', args: [undefined, 'exactPartial'], failure: SchemaUnsupportedOperation },
      { method: 'derive', args: [undefined, 'deepPartial'], failure: SchemaUnsupportedOperation },
      { method: 'policy', args: [undefined, 'catchall'], failure: SchemaUnsupportedOperation }
    ]
  }
]

describe('provider capability matrices', () => {
  test('each matrix is executable and distinguishes absent capabilities', () => {
    for (const provider of providerCases) {
      const local = Schema.with(provider.adapter)
      const supported = new Set(provider.supported)

      for (const name of allCapabilities) {
        expect(typeof capability(local, name)).toBe('function')
      }
      expect([...supported].every((name) => allCapabilities.includes(name))).toBe(true)

      expect(Result.isOk(noThrowSync(() => invoke(local, 'read', [provider.schema])))).toBe(true)
      const fields = unwrapOk(
        noThrowSync(() => invoke(local, 'fields', [provider.schema])) as never
      ) as Record<string, unknown>
      expect(Object.keys(fields).sort()).toEqual([...provider.fields].sort())

      const descriptor = {
        schema: provider.schema,
        propsSchema: provider.schema,
        construct: (value: unknown) => value
      }
      expect(unwrapOk(noThrowSync(() => invoke(local, 'props', [descriptor])))).toBeDefined()
      expect(
        unwrapOk(
          noThrowSync(() => invoke(local, 'make', [descriptor, { id: 'provider', count: 1 }]))
        )
      ).toEqual({ id: 'provider', count: 1 })
      expect(unwrapOk(noThrowSync(() => invoke(local, 'encoded', [provider.schema])))).toBeDefined()

      const picked = unwrapOk(
        noThrowSync(() => invoke(local, 'derive', [provider.schema, 'pick', { id: true }])) as never
      )
      expect(picked).toBeDefined()

      const invalidMask = noThrowSync(() =>
        invoke(local, 'derive', [provider.schema, 'pick', { missing: true }])
      )
      expectFailure(invalidMask as never, SchemaDefinitionFailure)

      const bridged = unwrapOk(
        noThrowSync(() => invoke(local, 'bridge', [provider.schema])) as never
      )
      expect(bridged).toBe(provider.schema)
    }
  })

  test('unsupported provider operations return typed errors instead of permissive schemas', () => {
    for (const provider of providerCases) {
      const local = Schema.with(provider.adapter)
      for (const operation of provider.unsupportedOperations) {
        const args = operation.args.map((value) => (value === undefined ? provider.schema : value))
        const result = noThrowSync(() => invoke(local, operation.method, args))
        expectFailure(result as never, operation.failure)
      }
    }
  })

  test('all providers decode native schemas through Standard Schema without adapters', () => {
    const values = [
      { schema: z.object({ id: z.string() }), input: { id: 'zod' } },
      { schema: v.object({ id: v.string() }), input: { id: 'valibot' } },
      { schema: arkType({ id: 'string' }), input: { id: 'arktype' } }
    ] as const

    for (const item of values) {
      const result = noThrowSync(() => Schema.decodeUnknown(item.schema, item.input))
      expect(Result.isOk(result)).toBe(true)
      if (Result.isOk(result)) expect(result.value).toEqual(item.input)
    }
  })

  test('Zod public bridge accepts raw shapes without changing provider identity', () => {
    const local = Schema.with(ZodAdapter)
    const bridged = unwrapOk(
      noThrowSync(() => invoke(local, 'bridge', [{ id: z.string() }])) as never
    ) as { readonly parse: (value: unknown) => unknown }
    expect(bridged.parse({ id: 'raw-shape' })).toEqual({ id: 'raw-shape' })
  })

  test('the matrix rejects foreign schemas at native capability boundaries', () => {
    const foreign = standardSchema(() => ({ value: { id: 'foreign', count: 1 } }), 'foreign')
    for (const provider of providerCases) {
      const local = Schema.with(provider.adapter)
      const result = noThrowSync(() => invoke(local, 'read', [foreign]))
      expectFailure(result as never, SchemaUnsupportedOperation)
    }
  })
})

describe('custom public-capability adapter', () => {
  test('uses only public capability contracts and has an independently checked matrix', () => {
    const schema = standardSchema(() => ({ value: { id: 'custom' } }))
    const adapter = {
      name: 'custom-conformance',
      read: {
        read(value: object) {
          return Result.ok(value)
        }
      },
      bridge: {
        bridge(value: object) {
          return Result.ok(value)
        }
      },
      jsonSchema: {
        toJSONSchema(_value: object, options: { readonly target: string }) {
          return Result.ok({
            $schema: options.target,
            type: 'object',
            properties: { id: { type: 'string' } }
          })
        }
      }
    }
    const local = Schema.with(adapter)

    expect(typeof capability(local, 'read')).toBe('function')
    expect(typeof capability(local, 'bridge')).toBe('function')
    expect(typeof capability(local, 'toJSONSchema')).toBe('function')
    expect(typeof capability(local, 'derive')).toBe('function')
    expect(typeof capability(local, 'encode')).toBe('function')

    expect(unwrapOk(noThrowSync(() => invoke(local, 'read', [schema])))).toBe(schema)
    expect(unwrapOk(noThrowSync(() => invoke(local, 'bridge', [schema])))).toBe(schema)
    expect(
      unwrapOk(
        noThrowSync(() =>
          invoke(local, 'toJSONSchema', [schema, { target: 'draft-2020-12' }])
        ) as never
      )
    ).toMatchObject({ type: 'object' })

    expectFailure(
      noThrowSync(() => invoke(local, 'derive', [schema, 'pick', { id: true }])) as never,
      SchemaUnsupportedOperation
    )
    expectFailure(
      noThrowSync(() => invoke(local, 'encode', [schema, { id: 'custom' }])) as never,
      SchemaUnsupportedOperation
    )
  })

  test('normalizes hostile public capability callbacks at the facade boundary', () => {
    const local = Schema.with({
      read: {
        read() {
          throw new Error('adapter secret')
        }
      },
      bridge: {
        bridge() {
          return Promise.reject(new Error('bridge secret'))
        }
      }
    })

    const read = noThrowSync(() => invoke(local, 'read', [{}]))
    expectFailure(read as never, SchemaExecutionFailure)

    const bridge = noThrowSync(() => invoke(local, 'bridge', [{}]))
    expectFailure(bridge as never, SchemaAsyncRequired)
  })
})
