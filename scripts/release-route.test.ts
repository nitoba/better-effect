import { expect, test } from 'bun:test'

const routeScript = new URL('./release-route.ts', import.meta.url).pathname

const routes = [
  { name: 'better-effect', prefix: 'v', version: '0.14.0' },
  { name: 'better-effect-better-auth', prefix: 'better-effect-better-auth-v' },
  { name: 'better-effect-http', prefix: 'better-effect-http-v' },
  { name: 'better-effect-kysely', prefix: 'better-effect-kysely-v' },
  { name: 'better-effect-mq', prefix: 'better-effect-mq-v' },
  { name: 'better-effect-mq-mongodb', prefix: 'better-effect-mq-mongodb-v' },
  { name: 'better-effect-mq-mysql', prefix: 'better-effect-mq-mysql-v' },
  { name: 'better-effect-mq-outbox', prefix: 'better-effect-mq-outbox-v' },
  { name: 'better-effect-mq-postgres', prefix: 'better-effect-mq-postgres-v' },
  { name: 'better-effect-mq-redis', prefix: 'better-effect-mq-redis-v' },
  { name: 'better-effect-mq-sqlite', prefix: 'better-effect-mq-sqlite-v' },
  { name: 'better-effect-schema', prefix: 'better-effect-schema-v' }
] as const

type ReleaseRoute = {
  readonly name: string
  readonly directory: string
  readonly changelog: string
  readonly tagPrefix: string
}

type ExportValue = string | null | Readonly<Record<string, ExportValue>>
type PackageManifest = {
  readonly private?: boolean
  readonly publishConfig?: { readonly access?: string; readonly registry?: string }
  readonly files?: readonly string[]
  readonly exports?: Readonly<Record<string, ExportValue>>
}

const runRoute = (...args: string[]) =>
  Bun.spawnSync({
    cmd: [process.execPath, routeScript, ...args],
    stdout: 'pipe',
    stderr: 'pipe'
  })

const readRoute = (...args: string[]) => {
  const result = runRoute(...args)
  expect(result.exitCode).toBe(0)

  return Object.fromEntries(
    result.stdout
      .toString()
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf('=')
        return [line.slice(0, separator), line.slice(separator + 1)]
      })
  )
}

test('resolves every qualified package route', () => {
  for (const route of routes) {
    const version = route.version ?? '0.1.0'
    expect(readRoute('--tag', `${route.prefix}${version}`)).toMatchObject({
      package_name: route.name,
      tag_prefix: route.prefix,
      release_version: version,
      initial_release: route.name === 'better-effect' ? 'false' : 'true'
    })
  }
})

test('keeps initial-release metadata for local package selection', () => {
  for (const route of routes) {
    expect(readRoute('--package', route.name)).toMatchObject({
      package_name: route.name,
      tag_prefix: route.prefix,
      initial_release: route.name === 'better-effect' ? 'false' : 'true'
    })
  }
})

test('keeps every route aligned with a public package manifest and changelog', async () => {
  // SAFETY: release-packages.json is repository-controlled and the assertions below validate its route shape.
  const config = (await Bun.file('scripts/release-packages.json').json()) as {
    readonly packages: readonly ReleaseRoute[]
  }
  expect(config.packages.map((route) => route.name).sort()).toEqual(
    routes.map((route) => route.name).sort()
  )
  const workflow = await Bun.file('.github/workflows/release-please.yml').text()

  for (const route of config.packages) {
    // SAFETY: package manifests are repository-controlled and the assertions below validate their release shape.
    const manifest = (await Bun.file(`${route.directory}/package.json`).json()) as PackageManifest
    expect(manifest.private).not.toBe(true)
    expect(manifest.publishConfig).toMatchObject({
      access: 'public',
      registry: 'https://registry.npmjs.org/'
    })
    expect(manifest.files?.length).toBeGreaterThan(0)
    expect(manifest.exports).toBeDefined()
    expect(await Bun.file(route.changelog).text()).not.toBe('')
    const tagPattern = route.tagPrefix === 'v' ? "'v*'" : `'${route.tagPrefix}*'`
    expect(workflow).toContain(tagPattern)
  }
})

test('rejects unallowlisted or malformed tags', () => {
  for (const tag of [
    'better-effect-v0.1.0',
    'better-effect-http-v1.0.0.0',
    'better-effect-mq-mongodb-v',
    'v'
  ]) {
    expect(runRoute('--tag', tag).exitCode).not.toBe(0)
  }
})

test('rejects ambiguous package selection', () => {
  expect(runRoute('--tag', 'v0.14.0', '--package', 'better-effect').exitCode).not.toBe(0)
  expect(runRoute('--package', 'private-app').exitCode).not.toBe(0)
})
