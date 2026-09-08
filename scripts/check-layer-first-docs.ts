import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '..')

const forbidden = [
  'ApplicationRuntimeAccess',
  'HonoEffect.make',
  'BetterAuthHooks.make',
  'BetterAuth.service',
  'Worker.start',
  'Worker.use',
  'Worker.startWith',
  'BunEffect.make',
  'NextEffect.make',
  'Database.layer',
  'startInfrastructure',
  'policyRuntime'
] as const

const requiredPackages = [
  'better-effect-http',
  'better-effect-schema',
  'better-effect-better-auth',
  'better-effect-kysely',
  'better-effect-mq',
  'better-effect-mq-outbox',
  'better-effect-mq-postgres',
  'better-effect-mq-redis',
  'better-effect-mq-mongodb',
  'better-effect-mq-sqlite',
  'better-effect-mq-mysql'
] as const

const docs = [
  'README.md',
  'apps/docs/content/docs',
  'packages/better-effect/README.md',
  'packages/better-effect-http/README.md',
  'packages/better-effect-schema/README.md',
  'packages/better-effect-better-auth/README.md',
  'packages/better-effect-kysely/README.md',
  'packages/better-effect-mq/README.md',
  'packages/better-effect-mq-outbox/README.md',
  'packages/better-effect-mq-postgres/README.md',
  'packages/better-effect-mq-redis/README.md',
  'packages/better-effect-mq-mongodb/README.md',
  'packages/better-effect-mq-sqlite/README.md',
  'packages/better-effect-mq-mysql/README.md'
] as const

const readFiles = async (path: string): Promise<readonly string[]> => {
  const absolute = resolve(repositoryRoot, path)
  if ((await Bun.file(absolute).exists())) return [absolute]

  const entries: string[] = []
  for await (const entry of new Bun.Glob('**/*.{md,mdx}').scan({ cwd: absolute, onlyFiles: true })) {
    entries.push(resolve(absolute, entry))
  }
  return entries
}

const fail = (message: string): never => {
  throw new Error(message)
}

const files = (await Promise.all(docs.map(readFiles))).flat()
const checked = files.filter((path) => !path.endsWith('/migration.mdx'))

for (const path of checked) {
  const contents = await Bun.file(path).text()
  for (const name of forbidden) {
    if (contents.includes(name)) fail(`${path} still documents removed API ${name}`)
  }
}

const migration = await Bun.file(resolve(repositoryRoot, 'apps/docs/content/docs/migration.mdx')).text()
for (const name of forbidden.slice(0, 10)) {
  if (!migration.includes(name)) fail(`migration guide is missing removed API ${name}`)
}

const packages = await Bun.file(resolve(repositoryRoot, 'apps/docs/content/docs/packages.mdx')).text()
for (const name of requiredPackages) {
  if (!packages.includes(name)) fail(`package catalog is missing ${name}`)
}

for (const path of [
  'apps/docs/content/docs/migration.mdx',
  'apps/docs/content/docs/packages.mdx',
  'apps/docs/content/docs/schema.mdx',
  'apps/docs/content/docs/outbox.mdx'
]) {
  if (!(await Bun.file(resolve(repositoryRoot, path)).exists())) fail(`missing documentation page ${path}`)
}

console.log(`Layer-first documentation audit passed (${checked.length} files checked).`)
