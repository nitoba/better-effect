// oxlint-disable anti-slop/no-unsafe-dictionary-type -- this test inspects a JSON package manifest.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- manifest fields are checked immediately below.

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>

const collect = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collect(path)))
    else files.push(path)
  }
  return files
}

const manifest = await readJson(join(packageRoot, 'package.json'))
if (manifest.name !== 'better-effect-mq-sqlite') throw new Error('Unexpected package name')
if (manifest.type !== 'module' || manifest.sideEffects !== false) {
  throw new Error('SQLite package must be side-effect-free ESM')
}
const exports = manifest.exports as Record<string, unknown>
for (const [name, target] of Object.entries({
  '.': './dist/index.mjs',
  './bun': './dist/bun.mjs',
  './node': './dist/node.mjs',
  './package.json': './package.json'
})) {
  if (exports[name] !== target) throw new Error(`Unexpected ${name} export`)
}
const peers = manifest.peerDependencies as Record<string, unknown>
for (const peer of ['better-effect', 'better-effect-mq', 'better-result', 'typescript']) {
  if (peers[peer] === undefined) throw new Error(`Missing ${peer} peer`)
}

const source = (
  await Promise.all((await collect(join(packageRoot, 'src'))).map((path) => readFile(path, 'utf8')))
).join('\n')
if (/from ['"](?:effect|@effect\/)/u.test(source))
  throw new Error('Effect dependency leaked into adapter')
if (
  /from ['"](?:bun:sqlite|node:sqlite)['"]/u.test(
    await readFile(join(packageRoot, 'src/index.ts'), 'utf8')
  )
)
  throw new Error('Host-specific SQLite driver leaked into the generic entrypoint')

const migration = await readFile(join(packageRoot, 'migrations/002_schedules.sql'), 'utf8')
for (const required of [
  'better_effect_mq_schedules',
  'better_effect_mq_schedules_due_idx',
  'better_effect_mq_schedules_group_idx',
  'better_effect_mq_schedules_key_idx'
]) {
  if (!migration.includes(required)) throw new Error(`Schedule migration is missing ${required}`)
}
console.log('SQLite package boundaries passed')
