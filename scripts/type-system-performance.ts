import { randomUUID } from 'node:crypto'
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = join(repoRoot, 'benchmarks/type-system/generated')
const corePackageRoot = join(repoRoot, 'packages/better-effect')
const betterAuthPackageRoot = join(repoRoot, 'packages/better-effect-better-auth')
const kyselyPackageRoot = join(repoRoot, 'packages/better-effect-kysely')
const mqPackageRoot = join(repoRoot, 'packages/better-effect-mq')
const performanceLock = join(
  tmpdir(),
  `better-effect-type-system-${repoRoot.replace(/[^a-zA-Z0-9]/g, '-')}.lock`
)
let fixtureCorePackageRoot = corePackageRoot
let fixtureMqPackageRoot = mqPackageRoot
const minimumTypeScriptVersion = '5.7.2'
const currentTypeScriptVersion = '6.0.3'
const performanceLockStaleAfterMs = 60_000

const sizes = [10, 25, 50, 100] as const
type Size = (typeof sizes)[number]
const jobSizes = [10, 50, 100, 250] as const
type JobSize = (typeof jobSizes)[number]
const producerSizes = [10, 50, 100] as const
type ProducerSize = (typeof producerSizes)[number]
const workerSizes = [10, 50, 100] as const
type WorkerSize = (typeof workerSizes)[number]
const honoSizes = [1, 3, 6, 10] as const
type HonoSize = (typeof honoSizes)[number]
const betterAuthSizes = [1] as const
type BetterAuthSize = (typeof betterAuthSizes)[number]

const scenarios = [
  'merge',
  'override',
  'runtime-make',
  'runtime-run',
  'transitive',
  'methods',
  'program-chain',
  'hono-mixed',
  'better-auth',
  'program-collections',
  'job-registry',
  'job-store',
  'job-producer',
  'worker-handlers',
  'kysely'
] as const
type Scenario = (typeof scenarios)[number]
type Compiler = 'current' | 'minimum'

type Metrics = {
  readonly files: number
  readonly types: number
  readonly instantiations: number
  readonly memoryKiB: number
  readonly checkMs: number
  readonly totalMs: number
}

type PreparedDependencies = {
  readonly corePackageRoot: string
  readonly mqPackageRoot: string
  readonly cleanup: () => Promise<void>
}

type Result = Metrics & {
  readonly compiler: Compiler
  readonly scenario: Scenario
  readonly size: number
  readonly fixture: string
  readonly status: 'ok' | 'error'
  readonly error: string | undefined
  readonly budgetExceeded: readonly string[]
}

type Budget = {
  readonly maxCheckMs: number
  readonly maxInstantiations: number
  readonly maxTypes: number
  readonly maxMemoryMiB: number
}

const runCommand = async (command: string[], cwd: string): Promise<void> => {
  const child = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  const output = `${stdout}\n${stderr}`

  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed with exit code ${exitCode}:\n${output}`)
  }
}

const packPackage = async (source: string, label: string, stagingRoot: string): Promise<string> => {
  const destination = join(stagingRoot, 'archives', label)
  await mkdir(destination, { recursive: true })
  await runCommand(['bun', 'pm', 'pack', '--destination', destination, '--ignore-scripts'], source)

  const archives = (await readdir(destination)).filter((entry) => entry.endsWith('.tgz'))
  if (archives.length !== 1) {
    throw new Error(`Expected one ${label} archive, found ${archives.length}`)
  }

  return join(destination, archives[0]!)
}

type PerformanceLockOwner = {
  readonly pid: number
  readonly token: string
  readonly createdAt: number
}

const hasErrorCode = (cause: unknown, code: string): boolean =>
  cause instanceof Error && 'code' in cause && cause.code === code

const isAlreadyExistsError = (cause: unknown): boolean => hasErrorCode(cause, 'EEXIST')

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    if (hasErrorCode(cause, 'ESRCH')) {
      return false
    }
    if (hasErrorCode(cause, 'EPERM')) {
      return true
    }
    throw cause
  }
}

const readPerformanceLockOwner = async (): Promise<PerformanceLockOwner | undefined> => {
  let contents: string
  try {
    contents = await readFile(join(performanceLock, 'owner.json'), 'utf8')
  } catch (cause) {
    if (hasErrorCode(cause, 'ENOENT')) {
      return undefined
    }
    throw cause
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      return undefined
    }
    throw cause
  }

  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Lock metadata crosses a process boundary and must be validated before use.
    typeof parsed !== 'object' ||
    parsed === null ||
    !('pid' in parsed) ||
    !('token' in parsed) ||
    !('createdAt' in parsed) ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Lock metadata crosses a process boundary and must be validated before use.
    typeof parsed.pid !== 'number' ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Lock metadata crosses a process boundary and must be validated before use.
    typeof parsed.token !== 'string' ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Lock metadata crosses a process boundary and must be validated before use.
    typeof parsed.createdAt !== 'number'
  ) {
    return undefined
  }
  return {
    pid: parsed.pid,
    token: parsed.token,
    createdAt: parsed.createdAt
  }
}

const lockCanBeReclaimed = async (): Promise<boolean> => {
  let lockCreatedAt: number
  try {
    lockCreatedAt = (await stat(performanceLock)).mtimeMs
  } catch (cause) {
    if (hasErrorCode(cause, 'ENOENT')) {
      return true
    }
    throw cause
  }

  const owner = await readPerformanceLockOwner()
  if (owner) {
    return !isProcessAlive(owner.pid)
  }

  return Date.now() - lockCreatedAt >= performanceLockStaleAfterMs
}

const reclaimPerformanceLock = async (): Promise<void> => {
  const staleLock = `${performanceLock}.stale-${process.pid}-${randomUUID()}`
  try {
    await rename(performanceLock, staleLock)
  } catch (cause) {
    if (hasErrorCode(cause, 'ENOENT')) {
      return
    }
    throw cause
  }
  await rm(staleLock, { recursive: true, force: true })
}

const acquirePerformanceLock = async (): Promise<() => Promise<void>> => {
  const owner: PerformanceLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now()
  }
  const ownerPath = join(performanceLock, 'owner.json')

  while (true) {
    try {
      await mkdir(performanceLock)
      try {
        await writeFile(ownerPath, JSON.stringify(owner), 'utf8')
      } catch (cause) {
        await rm(performanceLock, { recursive: true, force: true })
        throw cause
      }
      let released = false
      return async () => {
        if (released) {
          return
        }
        released = true
        const currentOwner = await readPerformanceLockOwner()
        if (currentOwner?.token === owner.token) {
          await rm(performanceLock, { recursive: true, force: true })
        }
      }
    } catch (cause) {
      if (!isAlreadyExistsError(cause)) {
        throw cause
      }
      if (await lockCanBeReclaimed()) {
        await reclaimPerformanceLock()
        continue
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
  }
}

const ensurePackageBuild = async (packageRoot: string): Promise<void> => {
  const hasDeclaration = await Bun.file(join(packageRoot, 'dist/index.d.mts')).exists()
  const hasRuntime = await Bun.file(join(packageRoot, 'dist/index.mjs')).exists()
  if (!hasDeclaration || !hasRuntime) {
    await runCommand(['bun', 'run', 'build'], packageRoot)
  }
}

const stagePublicPackages = async (
  includeBetterAuth: boolean,
  includeKysely: boolean
): Promise<void> => {
  const stagingRoot = await mkdtemp(join(tmpdir(), 'better-effect-type-system-'))

  try {
    await ensurePackageBuild(corePackageRoot)
    if (includeBetterAuth) {
      await ensurePackageBuild(betterAuthPackageRoot)
    }
    if (includeKysely) {
      await ensurePackageBuild(kyselyPackageRoot)
    }
    const coreArchive = await packPackage(corePackageRoot, 'better-effect', stagingRoot)
    const betterAuthArchive = includeBetterAuth
      ? await packPackage(betterAuthPackageRoot, 'better-effect-better-auth', stagingRoot)
      : undefined
    const kyselyArchive = includeKysely
      ? await packPackage(kyselyPackageRoot, 'better-effect-kysely', stagingRoot)
      : undefined
    const consumerRoot = join(stagingRoot, 'consumer')
    const archiveReference = (archive: string): string =>
      `file:./${relative(consumerRoot, archive).split(sep).join('/')}`
    const dependencies = new Map<string, string>([
      ['better-effect', archiveReference(coreArchive)],
      ['better-result', '3.0.0']
    ])

    if (includeBetterAuth && betterAuthArchive) {
      dependencies.set('better-auth', '1.7.2')
      dependencies.set('better-effect-better-auth', archiveReference(betterAuthArchive))
    }
    if (includeKysely && kyselyArchive) {
      dependencies.set('better-effect-kysely', archiveReference(kyselyArchive))
      dependencies.set('kysely', '0.29.5')
    }

    await mkdir(consumerRoot, { recursive: true })
    await writeFile(
      join(consumerRoot, 'package.json'),
      `${JSON.stringify(
        {
          private: true,
          type: 'module',
          dependencies: Object.fromEntries(dependencies),
          devDependencies: {
            '@types/bun': '1.3.14',
            typescript: currentTypeScriptVersion
          }
        },
        null,
        2
      )}\n`
    )
    await runCommand(['bun', 'install', '--ignore-scripts'], consumerRoot)
    await cp(join(consumerRoot, 'node_modules'), join(fixtureRoot, 'node_modules'), {
      recursive: true,
      dereference: true
    })
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }

  for (const packageName of [
    'better-effect',
    ...(includeBetterAuth ? ['better-effect-better-auth'] : []),
    ...(includeKysely ? ['better-effect-kysely'] : [])
  ]) {
    const declaration = join(fixtureRoot, 'node_modules', packageName, 'dist/index.d.mts')
    if (!(await Bun.file(declaration).exists())) {
      throw new Error(`Staged ${packageName} package is missing its public declaration`)
    }
  }
}

// These are intentionally generous ceilings for a developer laptop. They are
// guardrails against accidental type-graph expansion, not CI latency SLAs.
const budgets = {
  10: { maxCheckMs: 2_000, maxInstantiations: 250_000, maxMemoryMiB: 512, maxTypes: 100_000 },
  25: { maxCheckMs: 3_000, maxInstantiations: 250_000, maxMemoryMiB: 512, maxTypes: 200_000 },
  50: { maxCheckMs: 6_000, maxInstantiations: 750_000, maxMemoryMiB: 768, maxTypes: 400_000 },
  100: {
    maxCheckMs: 12_000,
    maxInstantiations: 2_000_000,
    maxMemoryMiB: 1_024,
    maxTypes: 800_000
  }
} satisfies Record<Size, Budget>

const betterAuthBudgets = {
  1: {
    maxCheckMs: 8_000,
    maxInstantiations: 1_000_000,
    maxMemoryMiB: 1_024,
    maxTypes: 800_000
  }
} satisfies Record<BetterAuthSize, Budget>

const jobBudgets = {
  10: { maxCheckMs: 2_000, maxInstantiations: 250_000, maxMemoryMiB: 512, maxTypes: 100_000 },
  50: { maxCheckMs: 6_000, maxInstantiations: 750_000, maxMemoryMiB: 768, maxTypes: 400_000 },
  100: {
    maxCheckMs: 12_000,
    maxInstantiations: 2_000_000,
    maxMemoryMiB: 1_024,
    maxTypes: 800_000
  },
  250: {
    maxCheckMs: 30_000,
    maxInstantiations: 6_000_000,
    maxMemoryMiB: 1_536,
    maxTypes: 1_500_000
  }
} satisfies Record<JobSize, Budget>

const producerBudgets = {
  10: { maxCheckMs: 4_000, maxInstantiations: 400_000, maxMemoryMiB: 768, maxTypes: 200_000 },
  50: { maxCheckMs: 10_000, maxInstantiations: 1_500_000, maxMemoryMiB: 1_024, maxTypes: 600_000 },
  100: {
    maxCheckMs: 20_000,
    maxInstantiations: 4_000_000,
    maxMemoryMiB: 1_536,
    maxTypes: 1_200_000
  }
} satisfies Record<ProducerSize, Budget>

const jobStoreBudgets = {
  10: { maxCheckMs: 4_000, maxInstantiations: 400_000, maxMemoryMiB: 768, maxTypes: 200_000 },
  50: { maxCheckMs: 10_000, maxInstantiations: 1_500_000, maxMemoryMiB: 1_024, maxTypes: 600_000 },
  100: {
    maxCheckMs: 20_000,
    maxInstantiations: 4_000_000,
    maxMemoryMiB: 1_536,
    maxTypes: 1_200_000
  },
  250: {
    maxCheckMs: 45_000,
    maxInstantiations: 12_000_000,
    maxMemoryMiB: 2_048,
    maxTypes: 2_500_000
  }
} satisfies Record<JobSize, Budget>

const workerBudgets = {
  10: { maxCheckMs: 4_000, maxInstantiations: 500_000, maxMemoryMiB: 768, maxTypes: 200_000 },
  50: { maxCheckMs: 15_000, maxInstantiations: 3_000_000, maxMemoryMiB: 1_024, maxTypes: 700_000 },
  100: {
    maxCheckMs: 45_000,
    maxInstantiations: 10_000_000,
    maxMemoryMiB: 1_536,
    maxTypes: 1_500_000
  }
} satisfies Record<WorkerSize, Budget>

const honoBudgets = {
  1: { maxCheckMs: 2_000, maxInstantiations: 400_000, maxMemoryMiB: 512, maxTypes: 100_000 },
  3: { maxCheckMs: 3_000, maxInstantiations: 450_000, maxMemoryMiB: 512, maxTypes: 200_000 },
  6: { maxCheckMs: 6_000, maxInstantiations: 500_000, maxMemoryMiB: 768, maxTypes: 400_000 },
  10: {
    maxCheckMs: 12_000,
    maxInstantiations: 600_000,
    maxMemoryMiB: 1_024,
    maxTypes: 800_000
  }
} satisfies Record<HonoSize, Budget>

const parseList = <T extends string>(value: string, allowed: readonly T[]): T[] => {
  const values = value.split(',').map((item) => item.trim())

  for (const item of values) {
    // SAFETY: `item` is checked against the caller-provided literal tuple before use.
    if (!allowed.includes(item as T)) {
      throw new Error(`Unknown value '${item}'. Allowed values: ${allowed.join(', ')}`)
    }
  }

  // SAFETY: Every parsed value passed the literal-tuple membership check above.
  return values as T[]
}

const parseSizes = (value: string): Size[] => {
  const values = value.split(',').map((item) => Number(item.trim()))

  for (const item of values) {
    // SAFETY: `item` is checked against the supported service-count literals before use.
    if (!sizes.includes(item as Size)) {
      throw new Error(`Unknown service count '${item}'. Allowed values: ${sizes.join(', ')}`)
    }
  }

  // SAFETY: Every parsed value passed the service-count membership check above.
  return values as Size[]
}

const parseJobSizes = (value: string): JobSize[] => {
  const values = value.split(',').map((item) => Number(item.trim()))

  for (const item of values) {
    // SAFETY: `item` is checked against the supported Job-count literals before use.
    if (!jobSizes.includes(item as JobSize)) {
      throw new Error(`Unknown Job count '${item}'. Allowed values: ${jobSizes.join(', ')}`)
    }
  }

  // SAFETY: Every parsed value passed the literal-tuple membership check above.
  return values as JobSize[]
}

const parseWorkerSizes = (value: string): WorkerSize[] => {
  const values = value.split(',').map((item) => Number(item.trim()))

  for (const item of values) {
    // SAFETY: `item` is checked against the supported Worker-handler literals before use.
    if (!workerSizes.includes(item as WorkerSize)) {
      throw new Error(
        `Unknown Worker handler count '${item}'. Allowed values: ${workerSizes.join(', ')}`
      )
    }
  }

  // SAFETY: Every parsed value passed the Worker-handler literal-tuple membership check above.
  return values as WorkerSize[]
}

const parseHonoSizes = (value: string): HonoSize[] => {
  const values = value.split(',').map((item) => Number(item.trim()))

  for (const item of values) {
    // SAFETY: `item` is checked against the supported middleware-count literals before use.
    if (!honoSizes.includes(item as HonoSize)) {
      throw new Error(
        `Unknown Hono middleware count '${item}'. Allowed values: ${honoSizes.join(', ')}`
      )
    }
  }

  // SAFETY: Every parsed value passed the middleware-count membership check above.
  return values as HonoSize[]
}

const parseBetterAuthSizes = (value: string): BetterAuthSize[] => {
  const values = value.split(',').map((item) => Number(item.trim()))

  for (const item of values) {
    // SAFETY: `item` is checked against the supported Better Auth-count literals before use.
    if (!betterAuthSizes.includes(item as BetterAuthSize)) {
      throw new Error(
        `Unknown Better Auth fixture count '${item}'. Allowed values: ${betterAuthSizes.join(', ')}`
      )
    }
  }

  // SAFETY: Every parsed value passed the Better Auth-count membership check above.
  return values as BetterAuthSize[]
}

type ParsedOptions = {
  readonly sizes: Size[]
  readonly jobSizes: JobSize[]
  readonly producerSizes: ProducerSize[]
  readonly workerSizes: WorkerSize[]
  readonly honoSizes: HonoSize[]
  readonly betterAuthSizes: BetterAuthSize[]
  readonly scenarios: Scenario[]
  readonly checkBudget: boolean
  readonly cleanDist: boolean
  readonly json: boolean
}

const parseArgs = (): ParsedOptions => {
  let selectedSizes: Size[] = [...sizes]
  let selectedJobSizes: JobSize[] = [...jobSizes]
  let selectedProducerSizes: ProducerSize[] = [...producerSizes]
  let selectedWorkerSizes: WorkerSize[] = [...workerSizes]
  let selectedHonoSizes: HonoSize[] = [...honoSizes]
  let selectedBetterAuthSizes: BetterAuthSize[] = [...betterAuthSizes]
  let selectedScenarios: Scenario[] = [...scenarios]
  let checkBudget = false
  let cleanDist = false
  let json = false

  for (const argument of process.argv.slice(2)) {
    if (argument === '--check-budget') {
      checkBudget = true
    } else if (argument === '--clean-dist') {
      cleanDist = true
    } else if (argument === '--json') {
      json = true
    } else if (argument.startsWith('--sizes=')) {
      selectedSizes = parseSizes(argument.slice('--sizes='.length))
    } else if (argument.startsWith('--job-sizes=')) {
      selectedJobSizes = parseJobSizes(argument.slice('--job-sizes='.length))
    } else if (argument.startsWith('--producer-sizes=')) {
      const parsed = argument
        .slice('--producer-sizes='.length)
        .split(',')
        .map((item) => Number(item.trim()))
      for (const item of parsed) {
        // SAFETY: `item` is checked against the supported producer-count literals before use.
        if (!producerSizes.includes(item as ProducerSize)) {
          throw new Error(
            `Unknown producer count '${item}'. Allowed values: ${producerSizes.join(', ')}`
          )
        }
      }
      // SAFETY: Every parsed value passed the producer-count membership check above.
      selectedProducerSizes = parsed as ProducerSize[]
    } else if (argument.startsWith('--worker-sizes=')) {
      selectedWorkerSizes = parseWorkerSizes(argument.slice('--worker-sizes='.length))
    } else if (argument.startsWith('--hono-sizes=')) {
      selectedHonoSizes = parseHonoSizes(argument.slice('--hono-sizes='.length))
    } else if (argument.startsWith('--better-auth-sizes=')) {
      selectedBetterAuthSizes = parseBetterAuthSizes(argument.slice('--better-auth-sizes='.length))
    } else if (argument.startsWith('--scenarios=')) {
      selectedScenarios = parseList(argument.slice('--scenarios='.length), scenarios)
    } else if (argument === '--help') {
      console.log(
        [
          'Usage: bun scripts/type-system-performance.ts [options]',
          '',
          `  --sizes=10,25,50,100       Service counts (default: ${sizes.join(',')})`,
          `  --job-sizes=10,50,100,250   Job definitions (default: ${jobSizes.join(',')})`,
          `  --producer-sizes=10,50,100  Producer pipeline size (default: ${producerSizes.join(',')})`,
          `  --worker-sizes=10,50,100    Worker handler counts (default: ${workerSizes.join(',')})`,
          `  --hono-sizes=1,3,6,10       Hono middleware counts (default: ${honoSizes.join(',')})`,
          `  --better-auth-sizes=1       Better Auth plugin fixtures (default: ${betterAuthSizes.join(',')})`,
          `  --scenarios=${scenarios.join(',')}  Fixtures to measure (default: all)`,
          '  --check-budget             Exit non-zero when a configured ceiling is exceeded',
          '  --clean-dist               Remove generated/core/MQ dist before preparing fixtures',
          '  --json                     Print machine-readable results'
        ].join('\n')
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument '${argument}'. Use --help for usage.`)
    }
  }

  return {
    sizes: selectedSizes,
    jobSizes: selectedJobSizes,
    producerSizes: selectedProducerSizes,
    workerSizes: selectedWorkerSizes,
    honoSizes: selectedHonoSizes,
    betterAuthSizes: selectedBetterAuthSizes,
    scenarios: selectedScenarios,
    checkBudget,
    cleanDist,
    json
  }
}

const serviceName = (index: number): string => `Service${String(index + 1).padStart(3, '0')}`

const serviceNames = (size: Size): string[] =>
  Array.from({ length: size }, (_, index) => serviceName(index))

const serviceDeclarations = (names: readonly string[], withMethods: boolean): string =>
  names
    .map((name) => {
      const methods = withMethods
        ? Array.from(
            { length: 5 },
            (_, index) => `  method${String(index + 1).padStart(2, '0')}(): Effect<string, never> {
    return Effect.gen(function* () {
      return Result.ok('${name}:method${String(index + 1).padStart(2, '0')}')
    })
  }`
          ).join('\n\n')
        : ''

      return `class ${name} extends Service<${name}>()('${name}') {
  value(): string {
    return '${name}'
  }
${methods ? `${methods}\n` : ''}}`
    })
    .join('\n\n')

const layerMerge = (names: readonly string[]): string =>
  `const AppLive = Layer.merge(\n  ${names.map((name) => `Layer.make(${name})`).join(',\n  ')}\n)`

const transitiveLayerMerge = (names: readonly string[]): string => {
  const layers = names.map((name, index) => {
    if (index === 0) {
      return `Layer.make(${name})`
    }

    const dependency = names[index - 1]!

    return `Layer.gen(${name}, async function* () {
    const dependency = yield* ${dependency}
    void dependency
    return new ${name}()
  })`
  })

  return `const AppLive = Layer.merge(\n  ${layers.join(',\n  ')}\n)`
}

const expectedProvidedChecks = (names: readonly string[]): string => {
  const expected = names.join(' | ')

  return `type ExpectedProvided = ${expected}
const providedFromLayer: ExpectedProvided = null as unknown as Layer.Provided<typeof AppLive>
const layerFromProvided: Layer.Provided<typeof AppLive> = null as unknown as ExpectedProvided
void providedFromLayer
void layerFromProvided`
}

const programCombinatorChain = (names: readonly string[]): string => {
  const sourceBody = names
    .map(
      (name) => `  const service${name} = yield* ${name}
  void service${name}`
    )
    .join('\n')
  const combinators = Array.from({ length: names.length }, (_, index) => {
    const current = `program${index}`
    const next = `program${index + 1}`

    switch (index % 6) {
      case 0:
        return `const ${next} = Program.map(${current}, (value) => value + 1)`
      case 1:
        return `const ${next} = Program.mapError(${current}, (error) => error)`
      case 2:
        return `const ${next} = Program.andThen(${current}, (value) =>
  Effect.gen(function* () {
    return Result.ok(value)
  })
)`
      case 3:
        return `const ${next} = Program.tap(${current}, (value) => {
  void value
})`
      case 4:
        return `const ${next} = Program.tapError(${current}, (error) => {
  void error
})`
      default:
        return `const ${next} = Program.recover(${current}, (error) => Result.err(error))`
    }
  }).join('\n\n')

  return `const program0 = Program.named(
  'benchmark.program-chain',
  Effect.fn(async function* () {
${sourceBody}
    return Result.ok(0)
  })
)

${combinators}

const namedFinal = Program.named('benchmark.program-chain.final', program${names.length})
void Runtime.run(AppLive, namedFinal)`
}

const programCollections = (names: readonly string[]): string => {
  const collectionNames = names.slice(0, 3)
  const programs = collectionNames
    .map(
      (name) => `  Effect.fn(async function* () {
    const service = yield* ${name}
    void service
    return Result.ok('${name}')
  })`
    )
    .join(',\n')
  const values = collectionNames.map((name) => `'${name}'`).join(', ')
  const firstService = names[0]!

  return `const collectionPrograms = [
${programs}
] as const

const collected = Program.all(collectionPrograms, {
  concurrency: 4,
  name: 'benchmark.collection'
})
const retained = Program.allResults(collectionPrograms, {
  concurrency: 4,
  name: 'benchmark.results'
})
const mapped = Program.forEach(
  [${values}] as const,
  (name, index) =>
    Effect.fn(async function* () {
      const service = yield* ${firstService}
      void service
      return Result.ok(\`\${index}:\${name}\`)
    }),
  { name: 'benchmark.each' }
)

void Runtime.run(AppLive, collected)
void Runtime.run(AppLive, retained)
void Runtime.run(AppLive, mapped)
`
}

const runtimeRunProgram = (names: readonly string[], callMethods: boolean): string => {
  const body = names
    .map((name) => {
      const methodCalls = callMethods
        ? Array.from(
            { length: 5 },
            (_, index) => `  service${name}.method${String(index + 1).padStart(2, '0')}()`
          ).join('\n')
        : ''

      return `  const service${name} = yield* ${name}
${methodCalls}`
    })
    .join('\n')

  return `const program = Effect.gen(async function* () {
${body}
  return Result.ok('ok')
})

void Runtime.run(AppLive, () => program)`
}

const fixtureModuleSpecifier = (packageRoot: string, entrypoint: string): string => {
  const path = relative(fixtureRoot, join(packageRoot, 'dist', entrypoint))
    .split(sep)
    .join('/')
  return path.startsWith('.') ? path : `./${path}`
}

const jobRegistryFixtureSource = (size: number): string => {
  const names = Array.from(
    { length: size },
    (_, index) => `Job${String(index + 1).padStart(3, '0')}`
  )
  const declarations = names
    .map(
      (name, index) =>
        `const ${name} = queue.job('job-${String(index + 1).padStart(3, '0')}', { version: 1, payload })`
    )
    .join('\n')
  const expected = names.map((name) => `typeof ${name}`).join(' | ')
  const tuple = names.join(', ')

  const mqEntry = fixtureModuleSpecifier(fixtureMqPackageRoot, 'index.mjs')

  return `import { Codec, JobRegistry, Queue } from '${mqEntry}'

const queue = Queue.define('benchmark.jobs')
const payload = Codec.json<{ readonly id: string }>()
${declarations}

const registry = JobRegistry.make([${tuple}] as const)
type ExpectedJobs = ${expected}
type ActualJobs = JobRegistry.Jobs<typeof registry>
type ExpectedTuple = readonly [${expected.replaceAll(' | ', ', ')}]
type ActualTuple = JobRegistry.Definitions<typeof registry>
const jobs: ExpectedJobs = null as unknown as ActualJobs
const definitions: ActualTuple = null as unknown as ExpectedTuple
const known = registry.lookup({ queue: 'benchmark.jobs', name: 'job-001', version: 1 })
const missing = registry.lookup({ queue: 'benchmark.jobs', name: 'missing', version: 1 })
void jobs
void definitions
void known
void missing
`
}

const jobStoreFixtureSource = (size: number): string => {
  const coreEntry = fixtureModuleSpecifier(fixtureCorePackageRoot, 'index.mjs')
  const mqEntry = fixtureModuleSpecifier(fixtureMqPackageRoot, 'index.mjs')
  const names = Array.from({ length: size }, (_, index) => String(index + 1).padStart(3, '0'))
  const tokenDeclarations = names
    .map((name) => `const Store${name} = JobStore.named('benchmark-${name}')`)
    .join('\n')
  const jobDeclarations = names
    .map(
      (name) =>
        `const Job${name} = queue.job('job-${name}', { version: 1, payload, store: Store${name} })`
    )
    .join('\n')
  const layers = names
    .map((name) => `Layer.succeed(Store${name}, Store${name}.of(implementation))`)
    .join(',\n  ')
  const jobs = names.map((name) => `Job${name}`).join(', ')
  const first = names[0]!

  return `import { Effect, Layer, Runtime } from '${coreEntry}'
import { Result } from '../../../packages/better-effect/node_modules/better-result'
import { Codec, Job, JobRegistry, JobStore, Queue } from '${mqEntry}'

const implementation = {} as JobStore.Contract
const queue = Queue.define('benchmark.store')
const payload = Codec.json<{ readonly id: string }>()
${tokenDeclarations}
${jobDeclarations}
const registry = JobRegistry.make([${jobs}] as const)
const AppLive = Layer.merge(
  ${layers}
)
const program = Effect.gen(async function* () {
  const store = yield* Store${first}
  const jobToken: typeof Store${first} = null as unknown as Job.StoreToken<typeof Job${first}>
  void registry
  void jobToken
  return Result.ok(store.descriptor.protocolVersion)
})
void Runtime.make(AppLive)
void Runtime.run(AppLive, () => program)
`
}

const jobProducerFixtureSource = (size: number): string => {
  const coreEntry = fixtureModuleSpecifier(fixtureCorePackageRoot, 'index.mjs')
  const coreServicesEntry = fixtureModuleSpecifier(fixtureCorePackageRoot, 'standard-services.mjs')
  const mqEntry = fixtureModuleSpecifier(fixtureMqPackageRoot, 'index.mjs')
  const names = Array.from(
    { length: size },
    (_, index) => `Job${String(index + 1).padStart(3, '0')}`
  )
  const declarations = names
    .map(
      (name, index) =>
        `const ${name} = queue.job('job-${String(index + 1).padStart(3, '0')}', { version: 1, payload, result: Codec.string, failure, store: JobStore })`
    )
    .join('\n')
  const enqueues = names
    .map(
      (name, index) =>
        `  const id${String(index + 1).padStart(3, '0')} = yield* ${name}.enqueue({ id: '${index + 1}' })`
    )
    .join('\n')
  const ids = names.map((_, index) => `id${String(index + 1).padStart(3, '0')}`).join(', ')

  return `import {
  Effect,
  Layer,
  Runtime,
  type EffectError,
  type EffectRequirements
} from '${coreEntry}'
import { Clock, ClockLive } from '${coreServicesEntry}'
import { Result } from '../../../packages/better-effect/node_modules/better-result'
import type { UnhandledException } from '../../../packages/better-effect/node_modules/better-result'
import {
  Codec,
  Job,
  JobStore,
  Queue,
  type JobAwaitAbortedError,
  type JobAwaitResultError,
  type JobDecodeFailure,
  type JobDefinitionError,
  type JobEnqueueError,
  type JobEncodeFailure,
  type JobExecutionCancelledError,
  type JobExecutionFailureError,
  type JobId,
  type JobIdentityMismatchError,
  type JobNotFoundError,
  type JobOperation,
  type JobStoreEnqueueError,
  type JobStoreGetJobError
} from '${mqEntry}'

type Assert<T extends true> = T
type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends
  (<Type>() => Type extends Right ? 1 : 2) ? true : false

const implementation = {} as JobStore.Contract
const queue = Queue.define('benchmark.producer')
type HandlerFailure = { readonly code: string }
const payload = Codec.json<{ readonly id: string }>()
const failure = Codec.json<HandlerFailure>()
${declarations}

type ExpectedEnqueueError =
  | JobDecodeFailure
  | JobEncodeFailure
  | JobDefinitionError
  | JobStoreEnqueueError
  | UnhandledException
type ExpectedAwaitError =
  | HandlerFailure
  | JobStoreGetJobError
  | JobIdentityMismatchError
  | JobNotFoundError
  | JobDecodeFailure
  | JobExecutionFailureError
  | JobExecutionCancelledError
  | JobAwaitAbortedError
  | UnhandledException
type ExpectedProducerError = ExpectedEnqueueError | ExpectedAwaitError
type _FailureExact = Assert<Equal<Job.Failure<typeof Job001>, HandlerFailure>>
type _EnqueueErrorExact = Assert<Equal<JobEnqueueError, ExpectedEnqueueError>>
type _AwaitErrorExact = Assert<Equal<JobAwaitResultError<HandlerFailure>, ExpectedAwaitError>>
type _EnqueueExact = Assert<Equal<
  ReturnType<typeof Job001.enqueue>,
  JobOperation<JobId, JobEnqueueError, typeof JobStore, true>
>>
type _AwaitExact = Assert<Equal<
  ReturnType<typeof Job001.awaitResult>,
  JobOperation<string, ExpectedAwaitError, typeof JobStore, true>
>>
type _ExecuteExact = Assert<Equal<
  ReturnType<typeof Job001.execute>,
  JobOperation<string, ExpectedProducerError, typeof JobStore, true>
>>

const program = Effect.gen(async function* () {
${enqueues}
  const completed = yield* Job001.awaitResult(id001)
  const executed = yield* Job001.execute({ id: 'execute' })
  return Result.ok({ ids: [${ids}], completed, executed })
})
type Requirements = EffectRequirements<typeof program>
type Errors = EffectError<typeof program>
type ExpectedRequirements = JobStore.Instance | InstanceType<typeof Clock>
type _RequirementsExact = Assert<Equal<Requirements, ExpectedRequirements>>
type _ErrorsExact = Assert<Equal<Errors, ExpectedProducerError>>

const AppLive = Layer.merge(
  Layer.succeed(JobStore, JobStore.of(implementation)),
  ClockLive
)
void Runtime.run(AppLive, () => program)
`
}

const workerFixtureSource = (size: number): string => {
  const coreEntry = fixtureModuleSpecifier(fixtureCorePackageRoot, 'index.mjs')
  const mqEntry = fixtureModuleSpecifier(fixtureMqPackageRoot, 'index.mjs')
  const names = Array.from(
    { length: size },
    (_, index) => `Job${String(index + 1).padStart(3, '0')}`
  )
  const jobs = names
    .map(
      (name, index) =>
        `const ${name} = queue.job('job-${String(index + 1).padStart(3, '0')}', { version: 1, payload, result: Codec.string })`
    )
    .join('\n')
  const handlers = names
    .map(
      (name) => `const ${name}Handler = Worker.handle(${name}, (input) =>
  Effect.fn(async function* () {
    const root = yield* WorkerRoot
    const context = yield* JobContext
    void root
    void context
    return Result.ok(input.id)
  })
)`
    )
    .join('\n\n')
  const handlerTuple = names.map((name) => `${name}Handler`).join(', ')

  return `import { Effect, Layer, Runtime, Service } from '${coreEntry}'
import { Result } from '../../../packages/better-effect/node_modules/better-result'
import { Codec, JobContext, JobStore, Queue, Worker, type WorkerRequirements } from '${mqEntry}'

class WorkerRoot extends Service<WorkerRoot>()('WorkerBenchmarkRoot') {}
const implementation = {} as JobStore.Contract
const queue = Queue.define('benchmark.worker')
const payload = Codec.json<{ readonly id: string }>()
${jobs}
${handlers}
const handlers = [${handlerTuple}] as const
type ExpectedRequirements = WorkerRoot | JobStore.Instance
type ActualRequirements = WorkerRequirements<typeof handlers>
const requirements: ExpectedRequirements = null as unknown as ActualRequirements
const reverseRequirements: ActualRequirements = null as unknown as ExpectedRequirements
const AppLive = Layer.merge(
  Layer.succeed(JobStore, JobStore.of(implementation)),
  Layer.succeed(WorkerRoot, WorkerRoot.of({}))
)
declare const runtime: Runtime.For<typeof AppLive>
void requirements
void reverseRequirements
void Worker.start(runtime, { handlers, concurrency: 8 })
void Worker.use(runtime, { handlers }, async (worker) => {
  await worker.awaitIdle()
  return worker.state
})
`
}

const honoValidatorTargets = ['param', 'header', 'query', 'cookie', 'json', 'form'] as const

type HonoValidatorTarget = (typeof honoValidatorTargets)[number]

const capitalize = (value: string): string => `${value[0]!.toUpperCase()}${value.slice(1)}`

const honoFixtureSource = (size: number): string => {
  const targets: HonoValidatorTarget[] = Array.from(
    { length: size },
    (_, index) => honoValidatorTargets[index % honoValidatorTargets.length]!
  )
  const readTargets = [...new Set(targets)]
  const middlewareNames = targets.map((target) => `validate${capitalize(target)}`)
  const middlewareArguments = middlewareNames.join(',\n  ')
  const reads = readTargets
    .map((target) => `    const ${target} = c.req.valid('${target}')`)
    .join('\n')
  const resultFields = readTargets.map((target) => `${target}: ${target}`).join(', ')
  const header = `import { Effect, Runtime } from '../../../packages/better-effect/src/index.ts'
import { HonoEffect } from '../../../packages/better-effect/src/hono/index.ts'
import { Result } from '../../../packages/better-effect/node_modules/better-result'
import { validator } from '../../../packages/better-effect/node_modules/hono/dist/types/validator/validator.js'

`

  return `${header}const runtime = {} as Runtime<never>
const http = HonoEffect.make(runtime)

const validateParam = validator('param', (value: { id?: string }) => ({
  id: value.id ?? ''
}))
const validateHeader = validator('header', (value: Record<string, string>) => ({
  requestId: value['x-request-id'] ?? ''
}))
const validateQuery = validator('query', () => ({
  page: '1'
}))
const validateCookie = validator('cookie', (value: Record<string, string>) => ({
  session: value.session ?? ''
}))
const validateJson = validator('json', (value: { name?: string } | null) => ({
  name: value?.name ?? ''
}))
const validateForm = validator('form', () => ({
  note: ''
}))

const generated = http.gen(
  ${middlewareArguments},
  async function* (c) {
${reads}
    return Result.ok({ ${resultFields} })
  },
  { status: 201 }
)

const generatedHandler = http.handler(
  ${middlewareArguments},
  (c) => {
${reads}
    return Effect.fn(async function* () {
      return Result.ok({ ${resultFields} })
    })
  },
  undefined
)

void generated
void generatedHandler
`
}

const kyselyFixtureSource = (size: number): string => {
  const serviceNames = Array.from(
    { length: size },
    (_, index) => `Database${String(index + 1).padStart(3, '0')}`
  )
  const schemas = serviceNames
    .map(
      (_, index) =>
        `type Schema${String(index + 1).padStart(3, '0')} = {\n  table${String(index + 1).padStart(3, '0')}: { id: number; value: string }\n}`
    )
    .join('\n\n')
  const declarations = serviceNames
    .map((name, index) => {
      const suffix = String(index + 1).padStart(3, '0')
      return `const ${name} = KyselyEffect.service<Schema${suffix}>()('@perf/${name}')\ndeclare const raw${suffix}: KyselyService<Schema${suffix}>\nconst layer${suffix} = ${name}.layer(() => raw${suffix})\nconst borrowed${suffix} = ${name}.succeed(raw${suffix})\ntype Expected${suffix} = KyselyServiceInstance<'@perf/${name}', Schema${suffix}>\ntype Provided${suffix} = Layer.Provided<typeof layer${suffix}>\ntype BorrowedProvided${suffix} = Layer.Provided<typeof borrowed${suffix}>\ntype Required${suffix} = Layer.Required<typeof layer${suffix}>\ntype Check${suffix} = Assert<Equal<Provided${suffix}, Expected${suffix}>>\ntype BorrowedCheck${suffix} = Assert<Equal<BorrowedProvided${suffix}, Expected${suffix}>>\ntype RequiredCheck${suffix} = Assert<Equal<Required${suffix}, never>>`
    })
    .join('\n\n')
  const layers = serviceNames
    .map((_, index) => `layer${String(index + 1).padStart(3, '0')}`)
    .join(',\n  ')
  const expected = serviceNames
    .map((name, index) => `Expected${String(index + 1).padStart(3, '0')}`)
    .join(' | ')

  return `import { Layer } from 'better-effect'
import { KyselyEffect } from 'better-effect-kysely'
import type { KyselyService, KyselyServiceInstance } from 'better-effect-kysely'

type Assert<Condition extends true> = Condition
type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2
    ? true
    : false

${schemas}

${declarations}

const AppLive = Layer.merge(
  ${layers}
)
type AppProvided = Layer.Provided<typeof AppLive>
type ExpectedProvided = ${expected}
type AppCheck = Assert<Equal<AppProvided, ExpectedProvided>>
void AppLive
`
}

const betterAuthFixtureSource = (size: number): string => {
  const names = Array.from({ length: size }, (_, index) => `Auth${index + 1}`)
  const declarations = names
    .map(
      (name) => `const raw${name} = betterAuth({ plugins: [performancePlugin] })
const ${name} = BetterAuth.service('@perf/${name}', raw${name})`
    )
    .join('\n')
  const layers =
    names.length === 1
      ? `${names[0]}.layer`
      : `Layer.merge(\n  ${names.map((name) => `${name}.layer`).join(',\n  ')}\n)`
  const services = names
    .map(
      (name) => `  const service${name} = yield* ${name}
  const endpoint${name} = yield* service${name}.api.performanceEndpoint()
  const session${name} = yield* service${name}.session.get(new Headers())`
    )
    .join('\n')
  const results = names
    .map((name) => `{ endpoint: endpoint${name}, session: session${name} }`)
    .join(', ')

  return `import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint } from 'better-auth/api'
import { Effect, Layer } from 'better-effect'
import { BetterAuth, type BetterAuthEndpointResult } from 'better-effect-better-auth'
import { Result } from 'better-result'

type Assert<Condition extends true> = Condition
type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends
  (<Type>() => Type extends Right ? 1 : 2) ? true : false
type IsAny<Value> = 0 extends 1 & Value ? true : false
type IsUnknown<Value> = IsAny<Value> extends true ? false : unknown extends Value ? true : false

const performancePlugin = {
  id: 'performance-plugin',
  endpoints: {
    performanceEndpoint: createAuthEndpoint(
      '/performance-endpoint',
      { method: 'GET' },
      async (context) => context.json({ ok: true as const })
    )
  },
  schema: {
    user: {
      fields: {
        plan: { required: false, type: 'string' }
      }
    },
    session: {
      fields: {
        tenantId: { required: false, type: 'string' }
      }
    }
  },
  $ERROR_CODES: {
    PERFORMANCE_PLUGIN_ERROR: {
      code: 'PERFORMANCE_PLUGIN_ERROR',
      message: 'Performance plugin failure'
    }
  }
} satisfies BetterAuthPlugin

${declarations}

type Auth = typeof raw${names[0]}
type Endpoint = BetterAuthEndpointResult<Auth['api']['performanceEndpoint']>
type Session = Auth['$Infer']['Session']
type Codes = BetterAuth.ErrorCode<Auth>
type _EndpointExact = Assert<Equal<Endpoint, { ok: true }>>
type _EndpointNotAny = Assert<Equal<IsAny<Endpoint>, false>>
type _EndpointNotUnknown = Assert<Equal<IsUnknown<Endpoint>, false>>
type _SessionUserExact = Assert<Equal<Session['user']['plan'], string | null | undefined>>
type _SessionFieldExact = Assert<Equal<Session['session']['tenantId'], string | null | undefined>>
type _SessionNotAny = Assert<Equal<IsAny<Session>, false>>
type _SessionNotUnknown = Assert<Equal<IsUnknown<Session>, false>>
type _CodePresent = Assert<Extract<'PERFORMANCE_PLUGIN_ERROR', Codes> extends never ? false : true>
type _CodeNotAny = Assert<Equal<IsAny<Codes>, false>>
type _CodeNotUnknown = Assert<Equal<IsUnknown<Codes>, false>>

const AppLive = ${layers}
const program = Effect.fn(async function* () {
${services}
  return Result.ok([${results}])
})

void AppLive
void program
`
}

const fixtureSource = (scenario: Scenario, size: number): string => {
  if (scenario === 'hono-mixed') {
    return honoFixtureSource(size)
  }
  if (scenario === 'better-auth') {
    return betterAuthFixtureSource(size)
  }

  if (scenario === 'job-registry') {
    return jobRegistryFixtureSource(size)
  }

  if (scenario === 'job-store') {
    return jobStoreFixtureSource(size)
  }

  if (scenario === 'job-producer') {
    return jobProducerFixtureSource(size)
  }

  if (scenario === 'worker-handlers') {
    return workerFixtureSource(size)
  }

  if (scenario === 'kysely') {
    return kyselyFixtureSource(size)
  }

  // SAFETY: Non-Hono scenarios are called only with the service-count literals parsed above.
  const names = serviceNames(size as Size)
  const withMethods = scenario === 'methods'
  const declarations = serviceDeclarations(names, withMethods)
  const header = `import { Effect, Layer, Program, Runtime, Service } from '../../../packages/better-effect/src/index.ts'
import { Result } from '../../../packages/better-effect/node_modules/better-result'

`

  if (scenario === 'transitive') {
    return `${header}${declarations}\n\n${transitiveLayerMerge(names)}\n\n${expectedProvidedChecks(names)}\nconst requiredFromLayer: never = null as unknown as Layer.Required<typeof AppLive>\nvoid requiredFromLayer\nvoid Runtime.make(AppLive)\n`
  }

  const layers = layerMerge(names)

  if (scenario === 'merge') {
    return `${header}${declarations}\n\n${layers}\n\n${expectedProvidedChecks(names)}\n`
  }

  if (scenario === 'override') {
    const overrides = names.map((name) => `Layer.make(${name})`).join(',\n  ')

    return `${header}${declarations}\n\n${layers}\nconst Overridden = Layer.override(\n  AppLive,\n  ${overrides}\n)\n\n${expectedProvidedChecks(names).replaceAll('AppLive', 'Overridden')}\n`
  }

  if (scenario === 'runtime-make') {
    return `${header}${declarations}\n\n${layers}\n\n${expectedProvidedChecks(names)}\nconst runtime = Runtime.make(AppLive)\ntype RuntimeProvided = Awaited<typeof runtime> extends Runtime<infer Provided> ? Provided : never\nconst providedFromRuntime: ExpectedProvided = null as unknown as RuntimeProvided\nvoid providedFromRuntime\nvoid runtime\n`
  }

  if (scenario === 'program-chain') {
    return `${header}${declarations}\n\n${layers}\n\n${programCombinatorChain(names)}\n`
  }

  if (scenario === 'program-collections') {
    return `${header}${declarations}\n\n${layers}\n\n${programCollections(names)}\n`
  }

  return `${header}${declarations}\n\n${layers}\n\n${runtimeRunProgram(names, withMethods)}\n`
}

const writeFixture = async (scenario: Scenario, size: number): Promise<string> => {
  const filename = `${scenario}-${size}.ts`
  const fixture = join(fixtureRoot, filename)

  await writeFile(fixture, fixtureSource(scenario, size))

  return fixture
}

const readMetric = (output: string, label: string): string | undefined => {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = output.match(new RegExp(`^${escapedLabel}:\\s*([0-9.]+)([A-Za-z]+)?`, 'm'))

  return match ? `${match[1]}${match[2] ?? ''}` : undefined
}

const currentTscCommand = async (usePublicDeclarations: boolean): Promise<string[]> => {
  if (usePublicDeclarations && process.env.TSC === undefined) {
    const stagedTsc = join(fixtureRoot, 'node_modules/typescript/bin/tsc')
    if (await Bun.file(stagedTsc).exists()) {
      return ['node', stagedTsc]
    }
  }

  const localTsc = join(repoRoot, 'packages/better-effect/node_modules/.bin/tsc')
  const tsc =
    process.env.TSC ??
    ((await Bun.file(localTsc).exists()) ? localTsc : (Bun.which('tsc') ?? 'tsc'))

  return [tsc]
}

const runTsc = async (
  fixture: string,
  compiler: Compiler,
  usePublicDeclarations: boolean
): Promise<{ readonly metrics: Metrics; readonly error: string | undefined }> => {
  const compilerCommand =
    compiler === 'minimum'
      ? ['bunx', '--bun', '--package', `typescript@${minimumTypeScriptVersion}`, 'tsc']
      : await currentTscCommand(usePublicDeclarations)
  const typeRoots = usePublicDeclarations
    ? join(fixtureRoot, 'node_modules/@types')
    : join(repoRoot, 'packages/better-effect/node_modules/@types')
  const child = Bun.spawn(
    [
      ...compilerCommand,
      '--noEmit',
      '--extendedDiagnostics',
      '--pretty',
      'false',
      '--incremental',
      'false',
      '--target',
      'ESNext',
      '--module',
      'ESNext',
      '--moduleResolution',
      'bundler',
      '--allowImportingTsExtensions',
      '--verbatimModuleSyntax',
      '--strict',
      '--skipLibCheck',
      '--noUncheckedIndexedAccess',
      '--exactOptionalPropertyTypes',
      '--lib',
      'DOM,ESNext,ES2023,ESNext.Disposable',
      '--typeRoots',
      typeRoots,
      '--types',
      'bun',
      fixture
    ],
    { cwd: fixtureRoot, stdout: 'pipe', stderr: 'pipe' }
  )

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  const output = `${stdout}\n${stderr}`

  const metric = (label: string): string => readMetric(output, label) ?? '0'
  const checkSeconds = Number.parseFloat(metric('Check time'))
  const totalSeconds = Number.parseFloat(metric('Total time'))
  const error =
    exitCode === 0
      ? undefined
      : output
          .split('\n')
          .filter((line) => /error TS\d+:/i.test(line))
          .slice(0, 3)
          .join(' | ') || `tsc exited with code ${exitCode}`

  return {
    metrics: {
      files: Number.parseInt(metric('Files'), 10),
      types: Number.parseInt(metric('Types'), 10),
      instantiations: Number.parseInt(metric('Instantiations'), 10),
      memoryKiB: Number.parseInt(metric('Memory used').replace(/K$/, ''), 10),
      checkMs: Math.round(checkSeconds * 1_000),
      totalMs: Math.round(totalSeconds * 1_000)
    },
    error
  }
}

const budgetFailures = (scenario: Scenario, size: number, metrics: Metrics): string[] => {
  // SAFETY: Each scenario branch indexes the budget table for its validated size tuple.
  const budget =
    scenario === 'hono-mixed'
      ? honoBudgets[size as HonoSize]
      : scenario === 'better-auth'
        ? betterAuthBudgets[size as BetterAuthSize]
        : scenario === 'job-store'
          ? jobStoreBudgets[size as JobSize]
          : scenario === 'job-producer'
            ? producerBudgets[size as ProducerSize]
            : scenario === 'job-registry'
              ? jobBudgets[size as JobSize]
              : scenario === 'worker-handlers'
                ? workerBudgets[size as WorkerSize]
                : budgets[size as Size]
  const failures: string[] = []

  if (metrics.checkMs > budget.maxCheckMs) {
    failures.push(`check ${metrics.checkMs}ms > ${budget.maxCheckMs}ms`)
  }

  if (metrics.instantiations > budget.maxInstantiations) {
    failures.push(`instantiations ${metrics.instantiations} > ${budget.maxInstantiations}`)
  }

  if (metrics.types > budget.maxTypes) {
    failures.push(`types ${metrics.types} > ${budget.maxTypes}`)
  }

  if (metrics.memoryKiB > budget.maxMemoryMiB * 1024) {
    failures.push(`memory ${Math.round(metrics.memoryKiB / 1024)}MiB > ${budget.maxMemoryMiB}MiB`)
  }

  return failures
}

const formatRow = (result: Result): string => {
  const budget = result.budgetExceeded.length === 0 ? 'ok' : result.budgetExceeded.join('; ')

  return [
    result.scenario.padEnd(16),
    result.compiler.padEnd(8),
    String(result.size).padStart(4),
    result.status.padEnd(5),
    String(result.files).padStart(5),
    String(result.types).padStart(8),
    String(result.instantiations).padStart(13),
    `${result.checkMs}ms`.padStart(8),
    `${result.totalMs}ms`.padStart(9),
    `${Math.round(result.memoryKiB / 1024)}MiB`.padStart(8),
    budget
  ].join(' | ')
}

const compilersFor = (scenario: Scenario): readonly Compiler[] =>
  scenario === 'better-auth' ||
  scenario === 'job-registry' ||
  scenario === 'job-store' ||
  scenario === 'job-producer' ||
  scenario === 'worker-handlers'
    ? ['current', 'minimum']
    : ['current']

const createIsolatedPackageRoot = async (sourceRoot: string, targetRoot: string): Promise<void> => {
  await mkdir(targetRoot, { recursive: true })
  await cp(join(sourceRoot, 'package.json'), join(targetRoot, 'package.json'))
  await mkdir(join(targetRoot, 'node_modules'), { recursive: true })
}

const prepareCleanDependencies = async (
  needsCoreDeclarations: boolean,
  needsMqDeclarations: boolean
): Promise<PreparedDependencies> => {
  if (!needsCoreDeclarations && !needsMqDeclarations) {
    return {
      corePackageRoot,
      mqPackageRoot,
      cleanup: async () => {}
    }
  }

  const stagingRoot = await mkdtemp(join(tmpdir(), 'better-effect-type-system-clean-'))
  const isolatedCoreRoot = join(stagingRoot, 'better-effect')
  const isolatedMqRoot = join(stagingRoot, 'better-effect-mq')

  try {
    if (needsCoreDeclarations) {
      await createIsolatedPackageRoot(corePackageRoot, isolatedCoreRoot)
      await symlink(
        join(corePackageRoot, 'node_modules/better-result'),
        join(isolatedCoreRoot, 'node_modules/better-result'),
        'dir'
      )
      await runCommand(
        [
          'bun',
          'run',
          'build',
          '--',
          '--out-dir',
          join(isolatedCoreRoot, 'dist'),
          '--no-exports',
          '--no-clean'
        ],
        corePackageRoot
      )
    }

    if (needsMqDeclarations) {
      await createIsolatedPackageRoot(mqPackageRoot, isolatedMqRoot)
      await symlink(
        needsCoreDeclarations ? isolatedCoreRoot : corePackageRoot,
        join(isolatedMqRoot, 'node_modules/better-effect'),
        'dir'
      )
      await symlink(
        join(mqPackageRoot, 'node_modules/better-result'),
        join(isolatedMqRoot, 'node_modules/better-result'),
        'dir'
      )
      await runCommand(
        [
          'bun',
          'run',
          'build',
          '--',
          '--out-dir',
          join(isolatedMqRoot, 'dist'),
          '--no-exports',
          '--no-clean'
        ],
        mqPackageRoot
      )
    }
  } catch (cause) {
    await rm(stagingRoot, { recursive: true, force: true })
    throw cause
  }

  return {
    corePackageRoot: needsCoreDeclarations ? isolatedCoreRoot : corePackageRoot,
    mqPackageRoot: needsMqDeclarations ? isolatedMqRoot : mqPackageRoot,
    cleanup: async () => {
      await rm(stagingRoot, { recursive: true, force: true })
      await ensurePackageBuild(corePackageRoot)
    }
  }
}

const prepareScenarioDependencies = async (
  selectedScenarios: readonly Scenario[],
  cleanDist: boolean
): Promise<PreparedDependencies> => {
  const needsMqDeclarations =
    selectedScenarios.includes('job-registry') ||
    selectedScenarios.includes('job-store') ||
    selectedScenarios.includes('job-producer') ||
    selectedScenarios.includes('worker-handlers')
  const needsCoreDeclarations =
    needsMqDeclarations ||
    selectedScenarios.includes('job-store') ||
    selectedScenarios.includes('job-producer') ||
    selectedScenarios.includes('worker-handlers')
  const isolateDependencies = cleanDist && needsMqDeclarations
  if (isolateDependencies) {
    // Keep package consumers usable after the isolated clean build. A standalone
    // package check may start without a previously built core declaration.
    await ensurePackageBuild(corePackageRoot)
  }
  const dependencies = isolateDependencies
    ? await prepareCleanDependencies(needsCoreDeclarations, needsMqDeclarations)
    : {
        corePackageRoot,
        mqPackageRoot,
        cleanup: async () => {}
      }

  if (cleanDist && !isolateDependencies) {
    await Promise.all([
      rm(join(corePackageRoot, 'dist'), { recursive: true, force: true }),
      rm(join(mqPackageRoot, 'dist'), { recursive: true, force: true })
    ])
  }

  if (!isolateDependencies && needsCoreDeclarations) {
    await ensurePackageBuild(corePackageRoot)
  }

  if (!isolateDependencies && needsMqDeclarations) {
    await ensurePackageBuild(mqPackageRoot)
  }

  const declarations = [
    ...(needsCoreDeclarations
      ? [
          join(dependencies.corePackageRoot, 'dist/index.d.mts'),
          join(dependencies.corePackageRoot, 'dist/standard-services.d.mts')
        ]
      : []),
    ...(needsMqDeclarations ? [join(dependencies.mqPackageRoot, 'dist/index.d.mts')] : [])
  ]

  for (const declaration of declarations) {
    if (!(await Bun.file(declaration).exists())) {
      throw new Error(
        `Required generated declaration is missing: ${relative(repoRoot, declaration)}`
      )
    }
  }

  return dependencies
}

const runPreparedPerformance = async (
  options: ParsedOptions,
  dependencies: PreparedDependencies
): Promise<void> => {
  const usePublicDeclarations =
    options.scenarios.includes('better-auth') || options.scenarios.includes('kysely')

  fixtureCorePackageRoot = dependencies.corePackageRoot
  fixtureMqPackageRoot = dependencies.mqPackageRoot

  if (usePublicDeclarations) {
    await stagePublicPackages(
      options.scenarios.includes('better-auth'),
      options.scenarios.includes('kysely')
    )
  } else {
    await mkdir(join(fixtureRoot, 'node_modules'), { recursive: true })
    await symlink(
      join(repoRoot, 'packages/better-effect-better-auth/node_modules/better-auth'),
      join(fixtureRoot, 'node_modules/better-auth'),
      'dir'
    )
    await symlink(fixtureCorePackageRoot, join(fixtureRoot, 'node_modules/better-effect'), 'dir')
  }

  const results: Result[] = []

  for (const scenario of options.scenarios) {
    const scenarioSizes =
      scenario === 'hono-mixed'
        ? options.honoSizes
        : scenario === 'better-auth'
          ? options.betterAuthSizes
          : scenario === 'job-registry' || scenario === 'job-store'
            ? options.jobSizes
            : scenario === 'job-producer'
              ? options.producerSizes
              : scenario === 'worker-handlers'
                ? options.workerSizes
                : options.sizes

    for (const size of scenarioSizes) {
      const fixture = await writeFixture(scenario, size)
      for (const compiler of compilersFor(scenario)) {
        const run = await runTsc(fixture, compiler, usePublicDeclarations)
        const budgetExceeded = budgetFailures(scenario, size, run.metrics)

        if (run.error) {
          budgetExceeded.push('compile error')
        }

        results.push({
          ...run.metrics,
          compiler,
          scenario,
          size,
          fixture,
          status: run.error ? 'error' : 'ok',
          error: run.error,
          budgetExceeded
        })
      }
    }
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    console.log(
      'scenario         | compiler | size | status | files |    types | instantiations |  check |    total |  memory | budget'
    )
    console.log(
      '-----------------|----------|------|--------|-------|----------|----------------|--------|----------|---------|-------'
    )
    console.log(results.map(formatRow).join('\n'))
    console.log(`\nFixtures: ${fixtureRoot}`)
    console.log('Budgets: use --check-budget to enforce the configured ceilings.')
    for (const result of results) {
      if (result.error) {
        console.log(
          `\n${result.scenario}-${result.size} (${result.compiler}) compiler error: ${result.error}`
        )
      }
    }
  }

  if (options.checkBudget) {
    const failures = results.filter(
      (result) => result.budgetExceeded.length > 0 || result.status === 'error'
    )

    if (failures.length > 0) {
      throw new Error(
        `Type-system budget exceeded in ${failures.length} fixture(s):\n${failures
          .map(
            (result) =>
              `${result.scenario}-${result.size} (${result.compiler}): ${result.budgetExceeded.join(', ')}`
          )
          .join('\n')}`
      )
    }
  }
}

const runPerformance = async (options: ParsedOptions): Promise<void> => {
  await rm(fixtureRoot, { recursive: true, force: true })
  await mkdir(fixtureRoot, { recursive: true })

  const dependencies = await prepareScenarioDependencies(options.scenarios, options.cleanDist)
  try {
    await runPreparedPerformance(options, dependencies)
  } finally {
    await dependencies.cleanup()
  }
}

const main = async (): Promise<void> => {
  const options = parseArgs()
  const releasePerformanceLock = await acquirePerformanceLock()

  try {
    await runPerformance(options)
  } finally {
    await releasePerformanceLock()
  }
}

await main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : cause)
  process.exitCode = 1
})
