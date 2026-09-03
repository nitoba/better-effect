// oxlint-disable anti-slop/no-unsafe-dictionary-type -- this test inspects a JSON package manifest.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- manifest shape is asserted by the checks below.

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
if (manifest.name !== 'better-effect-mq-postgres') throw new Error('Unexpected package name')
if (manifest.type !== 'module' || manifest.sideEffects !== false) {
  throw new Error('PostgreSQL package must be side-effect-free ESM')
}
const exports = manifest.exports as Record<string, unknown>
if (exports['.'] !== './dist/index.mjs') throw new Error('Unexpected main export')
if (exports['./package.json'] !== './package.json') throw new Error('Missing package export')
const peers = manifest.peerDependencies as Record<string, unknown>
if (peers['better-effect-mq'] === undefined || peers.pg === undefined) {
  throw new Error('Expected MQ and pg peers')
}
const peerMeta = manifest.peerDependenciesMeta as Record<string, Record<string, unknown>>
if (peerMeta.pg?.optional !== true) throw new Error('pg must remain optional')

const source = (
  await Promise.all((await collect(join(packageRoot, 'src'))).map((path) => readFile(path, 'utf8')))
).join('\n')
if (/from ['"](?:effect|@effect\/)/u.test(source))
  throw new Error('Effect dependency leaked into adapter')
const migration = await readFile(join(packageRoot, 'migrations/001_initial.sql'), 'utf8')
if (!migration.includes('{{SCHEMA}}')) throw new Error('Migration schema placeholder is missing')
if (!migration.includes('better_effect_mq_jobs_claim_idx')) {
  throw new Error('Claim index is missing from the migration')
}
console.log('PostgreSQL package boundaries passed')
