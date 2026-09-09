import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixtureRoot = join(root, 'tests/package/consumers')
const temporary = await mkdtemp(join(tmpdir(), 'better-effect-schema-consumers-'))

const versions = {
  '@standard-schema/spec': '1.1.0',
  '@types/node': '26.1.2',
  'better-effect': '0.13.0',
  'better-result': '3.0.1',
  typescript: '7.0.2',
  arktype: '2.2.3',
  valibot: '1.4.2',
  zod: '4.5.4'
}

const providerNames = ['zod', 'valibot', 'arktype']
const cases = [
  { name: 'core-only', fixture: 'core-only.ts', providers: [] },
  { name: 'zod-only', fixture: 'zod-only.ts', providers: ['zod'] },
  { name: 'valibot-only', fixture: 'valibot-only.ts', providers: ['valibot'] },
  { name: 'arktype-only', fixture: 'arktype-only.ts', providers: ['arktype'] },
  { name: 'json-schema', fixture: 'json-schema.ts', providers: [] },
  {
    name: 'all-providers',
    fixture: 'all-providers.ts',
    providers: ['zod', 'valibot', 'arktype']
  }
]

const run = (command, args, cwd, capture = false) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit'
  })

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status !== 0) {
    if (capture) process.stderr.write(output)
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }

  return output
}

const requireFile = (path) => {
  const result = spawnSync('cat', [path], { encoding: null })
  if (result.status !== 0 || result.stdout === null) throw new Error(`Unable to read ${path}`)
  return result.stdout
}

const readArchiveEntries = (archive) =>
  run('tar', ['-tzf', archive], root, true)
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)

const assertArchive = (archive) => {
  const entries = readArchiveEntries(archive)
  const forbidden = entries.filter((entry) =>
    /(?:^|\/)(?:node_modules|src|tests|type-tests|examples|\.git)(?:\/|$)/u.test(entry)
  )

  if (forbidden.length > 0) {
    throw new Error(`Packed archive contains workspace-only entries:\n${forbidden.join('\n')}`)
  }

  for (const required of [
    'package/package.json',
    'package/LICENSE',
    'package/README.md',
    'package/CHANGELOG.md',
    'package/VERIFICATION.md',
    'package/dist/esm/index.js',
    'package/dist/esm/index.d.ts',
    'package/dist/esm/zod.js',
    'package/dist/esm/zod.d.ts',
    'package/dist/esm/valibot.js',
    'package/dist/esm/valibot.d.ts',
    'package/dist/esm/arktype.js',
    'package/dist/esm/arktype.d.ts'
  ]) {
    if (!entries.includes(required)) throw new Error(`Packed archive is missing ${required}`)
  }

  const digest = createHash('sha256').update(requireFile(archive)).digest('hex')
  console.log(`archive sha256: ${digest}`)
}

const packageExists = async (path) => {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

const assertNoWorkspaceLinks = async (directory) => {
  const workspaceRoot = root.endsWith(sep) ? root : `${root}${sep}`
  const entries = await readdir(directory, { withFileTypes: true })

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await realpath(path)
      if (target === root || target.startsWith(workspaceRoot)) {
        throw new Error(`External consumer links into the workspace: ${path} -> ${target}`)
      }
      continue
    }
    if (entry.isDirectory()) await assertNoWorkspaceLinks(path)
  }
}

const writeConsumer = async (consumer, archive, currentCase) => {
  const dependencies = {
    'better-effect-schema': `file:${archive}`,
    '@standard-schema/spec': versions['@standard-schema/spec'],
    '@types/node': versions['@types/node'],
    'better-effect': versions['better-effect'],
    'better-result': versions['better-result'],
    typescript: versions.typescript
  }

  for (const provider of currentCase.providers) dependencies[provider] = versions[provider]

  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: `better-effect-schema-external-${currentCase.name}`,
        private: true,
        type: 'module',
        dependencies
      },
      null,
      2
    )
  )

  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2022', 'DOM', 'ESNext.Disposable'],
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          types: ['node'],
          outDir: 'out'
        },
        include: ['smoke.ts']
      },
      null,
      2
    )
  )

  await writeFile(
    join(consumer, 'smoke.ts'),
    await readFile(join(fixtureRoot, currentCase.fixture), 'utf8')
  )
}

const installConsumer = (consumer) => {
  run('bun', ['install', '--ignore-scripts'], consumer)
  run('bun', ['install', '--frozen-lockfile', '--ignore-scripts'], consumer)
}

const assertDependencies = async (consumer, currentCase) => {
  const modules = join(consumer, 'node_modules')
  for (const dependency of [
    '@standard-schema/spec',
    '@types/node',
    'better-effect',
    'better-result',
    'typescript',
    ...currentCase.providers
  ]) {
    if (!(await packageExists(join(modules, dependency)))) {
      throw new Error(`${currentCase.name} is missing installed dependency ${dependency}`)
    }
  }

  for (const provider of providerNames) {
    if (currentCase.providers.includes(provider)) continue
    if (await packageExists(join(modules, provider))) {
      throw new Error(`${currentCase.name} unexpectedly installed optional peer ${provider}`)
    }
  }

  await assertNoWorkspaceLinks(modules)
}

const assertPackedManifest = async (consumer) => {
  const packageRoot = join(consumer, 'node_modules/better-effect-schema')
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const sourcePackageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (
    packageJson.name !== sourcePackageJson.name ||
    packageJson.version !== sourcePackageJson.version
  ) {
    throw new Error(
      `Packed package identity is invalid: expected ${sourcePackageJson.name}@${sourcePackageJson.version}, got ${packageJson.name}@${packageJson.version}`
    )
  }
  if (typeof packageJson.dependencies?.['@standard-schema/spec'] !== 'string') {
    throw new Error('Packed package must expose @standard-schema/spec as a production dependency')
  }
  for (const provider of providerNames) {
    if (packageJson.peerDependenciesMeta?.[provider]?.optional !== true) {
      throw new Error(`Packed package must mark ${provider} as an optional peer`)
    }
  }
}

const typecheck = (consumer) => {
  const tsc = join(consumer, 'node_modules/typescript/bin/tsc')
  run(process.execPath, [tsc, '-p', join(consumer, 'tsconfig.json'), '--pretty', 'false'], consumer)
}

const runSmoke = (consumer, name) => {
  const compiled = join(consumer, 'out/smoke.js')
  run(process.execPath, [compiled], consumer)
  run('node', [compiled], consumer)
  console.log(`${name}: typecheck, Bun, and Node smoke passed`)
}

try {
  const nodeVersion = run('node', ['--version'], root, true).trim()
  const nodeMajor = Number(/^v(\d+)/u.exec(nodeVersion)?.[1])
  if (!Number.isFinite(nodeMajor) || nodeMajor < 24) {
    throw new Error(`Current Node.js LTS is required; found ${nodeVersion}`)
  }
  console.log(`node runtime: ${nodeVersion}`)

  const artifacts = join(temporary, 'artifacts')
  await mkdir(artifacts, { recursive: true })
  run('bun', ['pm', 'pack', '--destination', artifacts, '--ignore-scripts'], root, true)
  const archives = (await readdir(artifacts)).filter((name) => name.endsWith('.tgz'))
  if (archives.length !== 1) throw new Error(`Expected one package archive, found ${archives.length}`)
  const archive = join(artifacts, archives[0])
  assertArchive(archive)

  for (const currentCase of cases) {
    const consumer = join(temporary, currentCase.name)
    await mkdir(consumer, { recursive: true })
    await writeConsumer(consumer, archive, currentCase)
    installConsumer(consumer)
    await assertDependencies(consumer, currentCase)
    await assertPackedManifest(consumer)
    typecheck(consumer)
    runSmoke(consumer, currentCase.name)
  }

  console.log('External tarball consumer matrix passed: 6 isolated cells.')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
