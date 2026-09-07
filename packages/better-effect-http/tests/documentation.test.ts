import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from 'bun:test'

const packageRoot = resolve(import.meta.dir, '..')
const docsRoot = resolve(packageRoot, '../../apps/docs/content/docs')

test('HTTP documentation keeps the executable recipe index in sync', async () => {
  const readme = await readFile(resolve(packageRoot, 'README.md'), 'utf8')
  const page = await readFile(resolve(docsRoot, 'http.mdx'), 'utf8')
  const examples = [
    'typed-client.ts',
    'auth-retry.ts',
    'endpoints-sdk.ts',
    'download.ts',
    'ndjson.ts',
    'sse-progress.ts',
    'sse-resumable.ts',
    'generation.ts',
    'hono-streaming.ts'
  ] as const

  for (const example of examples) {
    expect(readme).toContain(example)
    expect(page).toContain(example)
    expect(await Bun.file(resolve(packageRoot, 'examples', example)).exists()).toBe(true)
  }
  expect(readme).toContain('better-effect-schema')
  expect(readme).toContain('reconnect: false')
  expect(page).toContain('Last-Event-ID')
})
