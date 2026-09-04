// oxlint-disable anti-slop/no-unsafe-dictionary-type -- this test inspects a JSON package manifest.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- manifest shape is asserted below.
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as Record<
  string,
  unknown
>
if (
  manifest.name !== 'better-effect-mq-mysql' ||
  manifest.type !== 'module' ||
  manifest.sideEffects !== false
)
  throw new Error('Unexpected MySQL package manifest')
const peers = manifest.peerDependencies as Record<string, unknown>
const peerMeta = manifest.peerDependenciesMeta as Record<string, Record<string, unknown>>
if (
  peers['better-effect-mq'] === undefined ||
  peers.mysql2 === undefined ||
  peerMeta.mysql2?.optional !== true
)
  throw new Error('Expected optional mysql2 and MQ peers')
const collect = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(async (entry) =>
        entry.isDirectory() ? collect(join(directory, entry.name)) : [join(directory, entry.name)]
      )
    )
  ).flat()
}
const source = (
  await Promise.all((await collect(join(packageRoot, 'src'))).map((path) => readFile(path, 'utf8')))
).join('\n')
if (/from ['"](?:effect|@effect\/)/u.test(source) || /\bMySql\b/u.test(source))
  throw new Error('Unexpected dependency leaked into MySQL adapter')
const migration = await readFile(join(packageRoot, 'migrations/001_initial.sql'), 'utf8')
if (
  !migration.includes('ENGINE=InnoDB') ||
  (!migration.includes('SKIP LOCKED') && !source.includes('SKIP LOCKED'))
)
  throw new Error('InnoDB claim requirements are missing')
console.log('MySQL package boundaries passed')
