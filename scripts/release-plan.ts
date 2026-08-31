import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

type ReleasePackage = {
  readonly name: string
  readonly directory: string
}

type ReleaseConfig = {
  readonly packages: readonly ReleasePackage[]
}

type PackageManifest = {
  readonly dependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
}

const repositoryRoot = resolve(import.meta.dir, '..')
// SAFETY: release-packages.json is repository-controlled release configuration.
const config = JSON.parse(
  await readFile(resolve(import.meta.dir, 'release-packages.json'), 'utf8')
) as ReleaseConfig
const packageNames = new Set(config.packages.map((entry) => entry.name))
const packageByDirectory = new Map(config.packages.map((entry) => [entry.directory, entry.name]))
const argumentValue = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

const base = argumentValue('--base')
const head = argumentValue('--head', 'HEAD')
const json = process.argv.includes('--json')
if (base === undefined || head === undefined)
  fail('Usage: --base <git-ref> [--head <git-ref>] [--json]')

const diff = Bun.spawnSync({
  cmd: [
    'git',
    'diff',
    '--name-status',
    '--diff-filter=ACMRD',
    `${base}...${head}`,
    '--',
    'packages'
  ],
  cwd: repositoryRoot,
  stdout: 'pipe',
  stderr: 'pipe'
})
if (diff.exitCode !== 0)
  fail(diff.stderr.toString().trim() || 'Unable to inspect the release range')

const changedFiles = diff.stdout
  .toString()
  .split(/\r?\n/)
  .flatMap((line) => {
    const [status, ...paths] = line.split('\t')
    if (status === undefined || paths.length === 0) return []
    return status.startsWith('R') || status.startsWith('C') ? paths : paths.slice(0, 1)
  })
  .map((file) => file.trim())
  .filter(Boolean)
const direct = new Set<string>()
for (const file of changedFiles) {
  for (const [directory, name] of packageByDirectory) {
    if (file === directory || file.startsWith(`${directory}/`)) direct.add(name)
  }
}

const dependents = new Map<string, Set<string>>()
for (const packageConfig of config.packages) {
  // SAFETY: each package.json is a repository-controlled manifest with string dependency ranges.
  const manifest = JSON.parse(
    await readFile(resolve(repositoryRoot, packageConfig.directory, 'package.json'), 'utf8')
  ) as PackageManifest
  const sections = [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
    manifest.devDependencies
  ]
  for (const section of sections) {
    for (const dependency of Object.keys(section ?? {})) {
      if (!packageNames.has(dependency)) continue
      const entries = dependents.get(dependency) ?? new Set<string>()
      entries.add(packageConfig.name)
      dependents.set(dependency, entries)
    }
  }
}

const affected = new Set(direct)
const pending = [...direct]
while (pending.length > 0) {
  const dependency = pending.shift()!
  for (const dependent of dependents.get(dependency) ?? []) {
    if (affected.has(dependent)) continue
    affected.add(dependent)
    pending.push(dependent)
  }
}

const ordered = (values: Set<string>): string[] =>
  config.packages.filter((entry) => values.has(entry.name)).map((entry) => entry.name)
const result = {
  base,
  head,
  changedFiles,
  direct: ordered(direct),
  affected: ordered(affected)
}

if (json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`Release range: ${base}...${head}`)
  console.log(`Directly changed packages: ${result.direct.join(', ') || '(none)'}`)
  console.log(
    `Packages to release with workspace dependents: ${result.affected.join(', ') || '(none)'}`
  )
}
