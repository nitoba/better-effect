// oxlint-disable anti-slop/no-unsafe-dictionary-type -- source maps are parsed only to remove embedded source text.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the map is immediately treated as a JSON object for sanitization.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

const files = await readdir(dist, { withFileTypes: true })
for (const file of files) {
  if (!file.isFile() || !file.name.endsWith('.map')) continue
  const path = join(dist, file.name)
  const map = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  delete map.sourcesContent
  await writeFile(path, `${JSON.stringify(map)}\n`)
}
