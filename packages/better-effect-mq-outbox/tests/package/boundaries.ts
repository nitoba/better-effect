// oxlint-disable anti-slop/no-unsafe-dictionary-type -- this test inspects a JSON package manifest.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- manifest shape is asserted below.

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
if (manifest.name !== 'better-effect-mq-outbox') throw new Error('Unexpected package name')
if (manifest.type !== 'module' || manifest.sideEffects !== false) {
  throw new Error('Outbox package must be side-effect-free ESM')
}

const exports = manifest.exports as Record<string, unknown>
if (
  JSON.stringify(Object.keys(exports).sort()) !==
  JSON.stringify(['.', './package.json', './testing'])
) {
  throw new Error('Unexpected outbox package exports')
}
if (exports['.'] !== './dist/index.mjs' || exports['./testing'] !== './dist/testing.mjs') {
  throw new Error('Unexpected outbox export targets')
}

const peers = manifest.peerDependencies as Record<string, unknown>
for (const name of ['better-effect', 'better-effect-mq', 'better-result', 'typescript']) {
  if (peers[name] === undefined) throw new Error(`Missing peer dependency: ${name}`)
}

const source = (
  await Promise.all((await collect(join(packageRoot, 'src'))).map((path) => readFile(path, 'utf8')))
).join('\n')
if (/from ['"](?:effect|@effect\/)/u.test(source)) {
  throw new Error('Effect dependency leaked into outbox')
}
if (/transaction\?\s*:\s*unknown|handle\s*:\s*unknown/u.test(source)) {
  throw new Error('Placeholder transaction or handle type leaked into outbox')
}

const core = await import(pathToFileURL(join(packageRoot, 'dist/index.mjs')).href)
const testing = await import(pathToFileURL(join(packageRoot, 'dist/testing.mjs')).href)
for (const name of ['MemoryOutboxStore', 'makeOutboxRecord', 'OutboxId']) {
  if (!(name in core)) throw new Error(`Missing core export: ${name}`)
}
if (Object.keys(testing).join(',') !== 'MemoryOutboxStore') {
  throw new Error('Unexpected testing exports')
}

console.log('better-effect-mq-outbox package boundary checks passed')
