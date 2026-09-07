import type { StandardJSONSchemaV1 } from '@standard-schema/spec'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema'

const document = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'External user',
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id']
}

const userSchema = {
  '~standard': {
    version: 1,
    vendor: 'external-json-schema',
    jsonSchema: {
      input: () => structuredClone(document),
      output: () => structuredClone(document)
    }
  }
} satisfies StandardJSONSchemaV1<{ readonly id: string }, { readonly id: string }>

const result = Schema.toJSONSchema(userSchema, {
  side: 'output',
  target: 'draft-2020-12'
})

if (Result.isError(result) || result.value.title !== 'External user') {
  throw new Error('JSON Schema consumer failed')
}

console.log('json-schema: ok')
