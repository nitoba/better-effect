import { expect, test } from 'bun:test'

import * as Http from '../src/index.ts'

test('exports typed HTTP foundations', () => {
  expect(Http.HttpRequest.make('https://example.test').method).toBe('GET')
  expect(Object.keys(Http)).toContain('HttpRequest')
})

test('request helpers are immutable and preserve repeated headers', () => {
  const original = Http.HttpRequest.make('https://example.test')
  const repeated = Http.HttpRequest.appendHeader(original, 'x-id', 'one')
  const derived = Http.HttpRequest.appendHeader(repeated, 'x-id', 'two')
  expect(original.headers.get('x-id')).toBeNull()
  expect(repeated.headers.get('x-id')).toBe('one')
  expect(derived.headers.get('x-id')).toBe('one, two')
})

test('invalid options are rejected before transport', () => {
  expect(Http.validateHttpOptions({ timeout: -1 })).toBeDefined()
  expect(Http.validateHttpOptions({ timeout: Number.NaN })).toBeDefined()
  expect(Http.validateHttpOptions({ expectedStatuses: [700] })).toBeDefined()
  expect(Http.validateHttpOptions({ timeout: 10, expectedStatuses: [200] })).toBeUndefined()
})
