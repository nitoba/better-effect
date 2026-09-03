import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

type ReleasePackage = {
  readonly name: string
  readonly directory: string
  readonly changelog: string
  readonly tagPrefix: string
  readonly initialRelease: boolean
  readonly additionalFiles?: readonly string[]
}

type ReleaseConfig = {
  readonly packages: readonly ReleasePackage[]
}

type PackageResolution = {
  readonly packageConfig: ReleasePackage
  readonly version?: string
}

const configPath = resolve(import.meta.dir, 'release-packages.json')
// SAFETY: release-packages.json is repository-controlled and validated by assertConfig below.
const config = JSON.parse(await readFile(configPath, 'utf8')) as ReleaseConfig
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

const argumentValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const assertConfig = (): void => {
  const names = new Set<string>()
  const prefixes = new Set<string>()

  for (const packageConfig of config.packages) {
    if (
      !packageConfig.name ||
      !packageConfig.directory ||
      !packageConfig.changelog ||
      !packageConfig.tagPrefix
    ) {
      fail('Release package entries require name, directory, changelog, and tagPrefix')
    }
    if (names.has(packageConfig.name)) fail(`Duplicate release package: ${packageConfig.name}`)
    if (prefixes.has(packageConfig.tagPrefix)) {
      fail(`Duplicate release tag prefix: ${packageConfig.tagPrefix}`)
    }
    names.add(packageConfig.name)
    prefixes.add(packageConfig.tagPrefix)
  }
}

const resolvePackage = (): PackageResolution => {
  const packageName = argumentValue('--package')
  const tag = argumentValue('--tag')

  if ((packageName === undefined) === (tag === undefined)) {
    fail('Usage: --tag <tag> or --package <name>')
  }

  if (packageName !== undefined) {
    const packageConfig = config.packages.find((entry) => entry.name === packageName)
    if (packageConfig === undefined) fail(`Package is not allowlisted: ${packageName}`)
    return { packageConfig }
  }

  const matches = config.packages.filter((entry) => tag!.startsWith(entry.tagPrefix))
  if (matches.length !== 1) fail(`Tag is not allowlisted: ${tag}`)
  const packageConfig = matches[0]!
  const version = tag!.slice(packageConfig.tagPrefix.length)
  if (!semverPattern.test(version)) fail(`Tag does not contain a valid SemVer version: ${tag}`)
  return { packageConfig, version }
}

assertConfig()
const { packageConfig, version } = resolvePackage()
const initialRelease =
  version === undefined
    ? packageConfig.initialRelease
    : packageConfig.initialRelease && version === '0.1.0'
const values = [
  { key: 'package_name', value: packageConfig.name },
  { key: 'package_dir', value: packageConfig.directory },
  { key: 'changelog', value: packageConfig.changelog },
  { key: 'tag_prefix', value: packageConfig.tagPrefix },
  { key: 'initial_release', value: String(initialRelease) }
]
if (version !== undefined) values.push({ key: 'release_version', value: version })

for (const entry of values) console.log(`${entry.key}=${entry.value}`)
