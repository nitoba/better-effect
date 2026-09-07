// oxlint-disable anti-slop/no-unsafe-dictionary-type -- this test inspects package metadata.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- manifest fields are asserted by the checks below.

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
if (manifest.name !== 'better-effect-mq-mongodb') throw new Error('Unexpected package name')
if (manifest.type !== 'module' || manifest.sideEffects !== false)
  throw new Error('MongoDB package must be side-effect-free ESM')
const exports = manifest.exports as Record<string, unknown>
if (exports['.'] !== './dist/index.mjs' || exports['./package.json'] !== './package.json')
  throw new Error('Unexpected package exports')
const peers = manifest.peerDependencies as Record<string, unknown>
if (
  peers['better-effect'] === undefined ||
  peers['better-effect-mq'] === undefined ||
  peers['better-effect-mq-outbox'] === undefined ||
  peers.mongodb === undefined
)
  throw new Error('Expected Better Effect, MQ, outbox, and MongoDB peers')
const peerMeta = manifest.peerDependenciesMeta as Record<string, Record<string, unknown>>
if (peerMeta.mongodb?.optional !== true) throw new Error('mongodb must remain optional')

const source = (
  await Promise.all((await collect(join(packageRoot, 'src'))).map((path) => readFile(path, 'utf8')))
).join('\n')
if (/from ['"](?:effect|@effect\/)/u.test(source))
  throw new Error('Effect dependency leaked into adapter')
if (/transaction\??:\s*unknown|handle:\s*unknown/u.test(source))
  throw new Error('Legacy unknown transaction API leaked into adapter')
if (!source.includes('findOneAndUpdate') || !source.includes('leaseToken'))
  throw new Error('Durable outbox claim and fencing implementation is missing')
if (
  !source.includes('MongoFlowStore') ||
  !source.includes('MONGODB_FLOW_PROTOCOL_VERSION') ||
  !source.includes('flowChildren') ||
  !source.includes('flowOutbox')
)
  throw new Error('MongoDB FlowStore v2 surface is missing')

const collections = await readFile(join(packageRoot, 'src/collections.ts'), 'utf8')
if (!collections.includes('MONGODB_LAYOUT_VERSION = 3') || !collections.includes('outbox:'))
  throw new Error('MongoDB outbox layout is missing')
console.log('MongoDB package boundaries passed')
