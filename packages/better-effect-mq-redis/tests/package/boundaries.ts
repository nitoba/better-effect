// oxlint-disable anti-slop/no-unsafe-dictionary-type -- this test inspects package metadata.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- package fields are checked immediately.

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
if (manifest.name !== 'better-effect-mq-redis') throw new Error('Unexpected package name')
if (manifest.type !== 'module' || manifest.sideEffects !== false) {
  throw new Error('Redis package must be side-effect-free ESM')
}
const exports = manifest.exports as Record<string, unknown>
if (exports['.'] !== './dist/index.mjs') throw new Error('Unexpected main export')
if (exports['./package.json'] !== './package.json') throw new Error('Missing package export')
const peers = manifest.peerDependencies as Record<string, unknown>
for (const peer of ['better-effect', 'better-effect-mq', 'better-result', 'redis']) {
  if (peers[peer] === undefined) throw new Error(`Missing ${peer} peer`)
}
const peerMeta = manifest.peerDependenciesMeta as Record<string, Record<string, unknown>>
if (peerMeta.redis?.optional !== true) throw new Error('redis must remain optional')

const source = (
  await Promise.all((await collect(join(packageRoot, 'src'))).map((path) => readFile(path, 'utf8')))
).join('\n')
if (/from ['"](?:effect|@effect\/)/u.test(source)) {
  throw new Error('Effect dependency leaked into adapter')
}
if (/\bTIME\b/u.test(source)) throw new Error('Redis server time leaked into the adapter')

const scriptDirectory = join(packageRoot, 'src/scripts')
for (const name of [
  'enqueue',
  'enqueue-many',
  'claim',
  'settle',
  'release',
  'heartbeat',
  'recover-stalled',
  'cancel',
  'promote',
  'retry',
  'remove',
  'pause',
  'resume'
]) {
  const script = await readFile(join(scriptDirectory, `${name}.lua`), 'utf8')
  if (!script.includes('KEYS') || !script.includes('ARGV')) {
    throw new Error(`Script ${name} must use KEYS and ARGV`)
  }
}
console.log('Redis package boundaries passed')
