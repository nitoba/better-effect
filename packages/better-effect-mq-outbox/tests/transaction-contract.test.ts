import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'

const readmePath = fileURLToPath(new URL('../README.md', import.meta.url))

test('the public outbox guide does not teach manual transaction lifecycle', async () => {
  const readme = await readFile(readmePath, 'utf8')

  expect(readme).not.toMatch(/pool\.connect\(\)/u)
  expect(readme).not.toMatch(/query\(['"](?:BEGIN|COMMIT|ROLLBACK)['"]\)/u)
  expect(readme).not.toMatch(/transaction\.release\(\)/u)
})

test('the public outbox guide assigns transaction ownership to adapters', async () => {
  const readme = await readFile(readmePath, 'utf8')

  expect(readme).toContain('adapter-owned transaction callback')
  expect(readme).toContain('appendIn')
  expect(readme).toContain('advanced')
})
