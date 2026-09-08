import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '..')
const docsRoot = resolve(repositoryRoot, 'apps/docs')
const packageRoot = resolve(repositoryRoot, 'packages/better-effect-http')
const examplesRoot = resolve(packageRoot, 'examples')
const decoder = new TextDecoder()

type CommandResult = Readonly<{
  readonly exitCode: number
  readonly output: string
}>

const fail = (message: string): never => {
  throw new Error(message)
}

const assertCondition = (condition: boolean, message: string): void => {
  if (!condition) fail(message)
}

const read = (path: string): Promise<string> => readFile(path, 'utf8')

const assertRequiredText = (source: string, required: readonly string[], label: string): void => {
  for (const text of required) {
    assertCondition(source.includes(text), `${label} is missing ${JSON.stringify(text)}`)
  }
}

const assertCodeFencesUseCanonicalSchemaPackage = (source: string, label: string): void => {
  for (const match of source.matchAll(/```[\s\S]*?```/g)) {
    assertCondition(
      !match[0].includes('better-effect-zod'),
      `${label} has a code fence using the historical schema package`
    )
  }
}

const assertLinks = async (source: string, label: string): Promise<void> => {
  const links = [...source.matchAll(/\]\(\/docs\/([^)#]+)(?:#[^)]+)?\)/g)]
  for (const match of links) {
    const page = match[1]
    if (page === undefined) fail(`${label} contains an invalid documentation link`)
    const directPath = resolve(docsRoot, 'content/docs', `${page}.mdx`)
    const indexPath = resolve(docsRoot, 'content/docs', page, 'index.mdx')
    const directExists = await Bun.file(directPath).exists()
    const indexExists = await Bun.file(indexPath).exists()
    assertCondition(
      directExists || indexExists,
      `${label} links to missing page /docs/${page}`
    )
  }
}

const run = (command: string[], cwd: string): CommandResult => {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  return {
    exitCode: result.exitCode,
    output: `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`
  }
}

const assertDocs = async (): Promise<void> => {
  const readme = await read(resolve(packageRoot, 'README.md'))
  const page = await read(resolve(docsRoot, 'content/docs/http.mdx'))
  const index = await read(resolve(docsRoot, 'content/docs/index.mdx'))
  const gettingStarted = await read(resolve(docsRoot, 'content/docs/getting-started.mdx'))
  const hono = await read(resolve(docsRoot, 'content/docs/hono.mdx'))
  const skill = await read(resolve(repositoryRoot, 'skills/better-effect/SKILL.md'))
  const skillDocumentation = await read(
    resolve(repositoryRoot, 'skills/better-effect/references/official-documentation.md')
  )
  // SAFETY: meta.json is a repository-owned navigation object; only its pages array is inspected.
  const meta = JSON.parse(await read(resolve(docsRoot, 'content/docs/meta.json'))) as {
    readonly pages?: readonly unknown[]
  }
  // SAFETY: package.json is a repository-owned manifest; only the script map is inspected.
  const packageManifest = JSON.parse(await read(resolve(packageRoot, 'package.json'))) as {
    readonly scripts?: Record<string, string>
  }
  const exampleNames = [
    'typed-client.ts',
    'auth-retry.ts',
    'endpoints-sdk.ts',
    'download.ts',
    'ndjson.ts',
    'sse-progress.ts',
    'sse-resumable.ts',
    'generation.ts',
    'hono-streaming.ts'
  ] as const

  assertCondition(meta.pages?.includes('http') === true, 'Documentation navigation misses http')
  assertRequiredText(index, ['/docs/http'], 'Documentation index')
  assertRequiredText(gettingStarted, ['/docs/http'], 'Getting Started documentation')
  assertRequiredText(hono, ['/docs/http'], 'Hono documentation')
  assertRequiredText(
    skill,
    ['### better-effect-http integration', '`HttpClient` is a Service', '`routes.stream`'],
    'better-effect Agent Skill'
  )
  assertRequiredText(skillDocumentation, ['/docs/http'], 'Agent Skill documentation map')
  assertRequiredText(
    readme,
    [
      '## Install',
      '## The operational model',
      '## Requests, methods, and responses',
      '## Interceptors, observers, and middleware',
      '## Retry and time budgets',
      '## Shared limits and isolation',
      '## Telemetry and propagation',
      '## Schemas and explicit encoding',
      '## Binary streaming',
      '## NDJSON',
      '## Server-sent events',
      '## Authentication recovery',
      '## Hono and Web streaming',
      '## Executable examples',
      '## Compatibility and limits',
      'HttpClient.service',
      'HttpRetry.transient',
      'Retry-After',
      'Last-Event-ID',
      'takeUntil(predicate, { requireMatch: true })',
      'bodyCodec',
      'WritableStream',
      'Schema.decodeUnknownAsync',
      'better-effect-schema/{zod,valibot,arktype}',
      'reconnect: false',
      'HttpAuthRefreshError',
      'routes.stream',
      'exactly-once'
    ],
    'Package README'
  )
  assertRequiredText(
    page,
    [
      '## Install and package boundaries',
      '## One Runtime, lazy operations, and Services',
      '## Methods, body/query, formats, and statuses',
      '## Interceptors, observers, and middleware',
      '## Retry, idempotency, and timeouts',
      '## Limits, queueing, and telemetry',
      '## Schemas, classes, and codecs',
      '## Streaming and NDJSON',
      '## SSE sessions and reconnect',
      '## Authentication recovery',
      '## Hono managed streaming',
      '## Recipes and executable verification',
      '## Deliberate limits',
      'better-effect-schema',
      'ofetch',
      'HttpRetry',
      'Retry-After',
      'Last-Event-ID',
      'bodyCodec',
      'takeUntil',
      'reconnect: false',
      'routes.stream',
      'exactly-once'
    ],
    'HTTP documentation'
  )
  assertCondition(
    packageManifest.scripts?.['test:docs'] === 'bun ../../scripts/check-http-docs.ts',
    'HTTP docs checker is not wired'
  )
  await assertLinks(readme, 'Package README')
  await assertLinks(page, 'HTTP documentation')
  await assertLinks(index, 'Documentation index')
  await assertLinks(gettingStarted, 'Getting Started documentation')
  await assertLinks(hono, 'Hono documentation')
  assertCodeFencesUseCanonicalSchemaPackage(readme, 'Package README')
  assertCodeFencesUseCanonicalSchemaPackage(page, 'HTTP documentation')

  for (const name of exampleNames) {
    const path = resolve(examplesRoot, name)
    assertCondition(await Bun.file(path).exists(), `Missing executable example ${name}`)
    const source = await read(path)
    assertCondition(
      !source.includes('better-effect-zod'),
      `${name} uses the historical schema package`
    )
  }

  const typecheck = run(['bun', 'run', 'typecheck:examples'], packageRoot)
  assertCondition(
    typecheck.exitCode === 0,
    `HTTP examples failed to typecheck:\n${typecheck.output}`
  )
  for (const name of exampleNames) {
    const result = run(['bun', 'run', resolve(examplesRoot, name)], examplesRoot)
    assertCondition(result.exitCode === 0, `HTTP example ${name} failed:\n${result.output}`)
  }
}

await assertDocs()
console.log('better-effect-http documentation checks passed')
