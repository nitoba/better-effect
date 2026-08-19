import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = join(repoRoot, 'benchmarks/type-system/generated')

const sizes = [10, 25, 50, 100] as const
type Size = (typeof sizes)[number]

const scenarios = [
  'merge',
  'override',
  'runtime-make',
  'runtime-run',
  'transitive',
  'methods'
] as const
type Scenario = (typeof scenarios)[number]

type Metrics = {
  readonly files: number
  readonly types: number
  readonly instantiations: number
  readonly memoryKiB: number
  readonly checkMs: number
  readonly totalMs: number
}

type Result = Metrics & {
  readonly scenario: Scenario
  readonly size: Size
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

// These are intentionally generous ceilings for a developer laptop. They are
// guardrails against accidental type-graph expansion, not CI latency SLAs.
const budgets = {
  10: { maxCheckMs: 2_000, maxInstantiations: 200_000, maxMemoryMiB: 512, maxTypes: 100_000 },
  25: { maxCheckMs: 3_000, maxInstantiations: 250_000, maxMemoryMiB: 512, maxTypes: 200_000 },
  50: { maxCheckMs: 6_000, maxInstantiations: 750_000, maxMemoryMiB: 768, maxTypes: 400_000 },
  100: {
    maxCheckMs: 12_000,
    maxInstantiations: 2_000_000,
    maxMemoryMiB: 1_024,
    maxTypes: 800_000
  }
} satisfies Record<Size, Budget>

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

type ParsedOptions = {
  readonly sizes: Size[]
  readonly scenarios: Scenario[]
  readonly checkBudget: boolean
  readonly json: boolean
}

const parseArgs = (): ParsedOptions => {
  let selectedSizes: Size[] = [...sizes]
  let selectedScenarios: Scenario[] = [...scenarios]
  let checkBudget = false
  let json = false

  for (const argument of process.argv.slice(2)) {
    if (argument === '--check-budget') {
      checkBudget = true
    } else if (argument === '--json') {
      json = true
    } else if (argument.startsWith('--sizes=')) {
      selectedSizes = parseSizes(argument.slice('--sizes='.length))
    } else if (argument.startsWith('--scenarios=')) {
      selectedScenarios = parseList(argument.slice('--scenarios='.length), scenarios)
    } else if (argument === '--help') {
      console.log(
        [
          'Usage: bun scripts/type-system-performance.ts [options]',
          '',
          `  --sizes=10,25,50,100       Service counts (default: ${sizes.join(',')})`,
          `  --scenarios=${scenarios.join(',')}  Fixtures to measure (default: all)`,
          '  --check-budget             Exit non-zero when a configured ceiling is exceeded',
          '  --json                     Print machine-readable results'
        ].join('\n')
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument '${argument}'. Use --help for usage.`)
    }
  }

  return { sizes: selectedSizes, scenarios: selectedScenarios, checkBudget, json }
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

const fixtureSource = (scenario: Scenario, size: Size): string => {
  const names = serviceNames(size)
  const withMethods = scenario === 'methods'
  const declarations = serviceDeclarations(names, withMethods)
  const header = `import { Effect, Layer, Runtime, Service } from '../../../packages/better-effect/src/index.ts'
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

  return `${header}${declarations}\n\n${layers}\n\n${runtimeRunProgram(names, withMethods)}\n`
}

const writeFixture = async (scenario: Scenario, size: Size): Promise<string> => {
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

const runTsc = async (
  fixture: string
): Promise<{ readonly metrics: Metrics; readonly error: string | undefined }> => {
  const localTsc = join(repoRoot, 'packages/better-effect/node_modules/.bin/tsc')
  const tsc =
    process.env.TSC ??
    ((await Bun.file(localTsc).exists()) ? localTsc : (Bun.which('tsc') ?? 'tsc'))
  const child = Bun.spawn(
    [
      tsc,
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
      join(repoRoot, 'packages/better-effect/node_modules/@types'),
      '--types',
      'bun',
      fixture
    ],
    { stdout: 'pipe', stderr: 'pipe' }
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

const budgetFailures = (size: Size, metrics: Metrics): string[] => {
  const budget = budgets[size]
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
    result.scenario.padEnd(12),
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

const main = async (): Promise<void> => {
  const options = parseArgs()

  await rm(fixtureRoot, { recursive: true, force: true })
  await mkdir(fixtureRoot, { recursive: true })

  const results: Result[] = []

  for (const scenario of options.scenarios) {
    for (const size of options.sizes) {
      const fixture = await writeFixture(scenario, size)
      const run = await runTsc(fixture)
      const budgetExceeded = budgetFailures(size, run.metrics)

      if (run.error) {
        budgetExceeded.push('compile error')
      }

      results.push({
        ...run.metrics,
        scenario,
        size,
        fixture,
        status: run.error ? 'error' : 'ok',
        error: run.error,
        budgetExceeded
      })
    }
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    console.log(
      'scenario     | size | status | files |    types | instantiations |  check |    total |  memory | budget'
    )
    console.log(
      '-------------|------|--------|-------|----------|----------------|--------|----------|---------|-------'
    )
    console.log(results.map(formatRow).join('\n'))
    console.log(`\nFixtures: ${fixtureRoot}`)
    console.log('Budgets: use --check-budget to enforce the configured ceilings.')
    for (const result of results) {
      if (result.error) {
        console.log(`\n${result.scenario}-${result.size} compiler error: ${result.error}`)
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
          .map((result) => `${result.scenario}-${result.size}: ${result.budgetExceeded.join(', ')}`)
          .join('\n')}`
      )
    }
  }
}

await main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : cause)
  process.exitCode = 1
})
