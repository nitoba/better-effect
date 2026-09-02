import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '..')
const docsRoot = resolve(repositoryRoot, 'apps/docs')
const packageRoot = resolve(repositoryRoot, 'packages/better-effect-kysely')

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

const assertLinks = async (source: string, label: string): Promise<void> => {
  const links = [...source.matchAll(/\]\(\/docs\/([^)#]+)(?:#[^)]+)?\)/g)]
  for (const match of links) {
    const page = match[1]
    if (page === undefined) fail(`${label} contains an invalid documentation link`)
    const path = resolve(docsRoot, 'content/docs', `${page}.mdx`)
    assertCondition(await Bun.file(path).exists(), `${label} links to missing page /docs/${page}`)
  }
}

const assertDocs = async (): Promise<void> => {
  const page = await read(resolve(docsRoot, 'content/docs/kysely.mdx'))
  const readme = await read(resolve(packageRoot, 'README.md'))
  const changelog = await read(resolve(packageRoot, 'CHANGELOG.md'))
  const index = await read(resolve(docsRoot, 'content/docs/index.mdx'))
  // SAFETY: the navigation fixture is parsed as JSON and only its optional pages array is inspected.
  const meta = JSON.parse(await read(resolve(docsRoot, 'content/docs/meta.json'))) as {
    readonly pages?: readonly unknown[]
  }
  const llmsIndex = await read(resolve(docsRoot, 'src/app/llms.txt/route.ts'))
  const llmsFull = await read(resolve(docsRoot, 'src/app/llms-full.txt/route.ts'))
  const source = await read(resolve(docsRoot, 'src/lib/source.ts'))
  const relatedDocs = await Promise.all(
    ['services', 'layers', 'effects', 'runtime', 'errors'].map(async (name) => ({
      name,
      contents: await read(resolve(docsRoot, 'content/docs', `${name}.mdx`))
    }))
  )

  assertCondition(meta.pages?.includes('kysely') === true, 'Documentation navigation misses kysely')
  assertRequiredText(index, ['/docs/kysely'], 'Documentation index')
  assertRequiredText(
    page,
    [
      '## Install the integration',
      '## The integration boundary',
      '## Owned and borrowed databases',
      '## Query terminals',
      '## Raw and compiled queries',
      '## Transactions',
      '### Transaction state machine',
      '## Cancellation',
      '## Errors and failure precedence',
      '## Multiple database Services',
      '## Composing with repositories',
      '## Testing the integration',
      '## Compatibility and limitations',
      'KyselyEffect.execute',
      'KyselyEffect.executeQuery',
      'KyselyEffect.transaction',
      'Result.err',
      'bodyFailure',
      'better-sqlite3',
      'directly yieldable Kysely builders'
    ],
    'Kysely documentation'
  )
  assertRequiredText(
    readme,
    [
      '## What it is',
      '## Why this design',
      '## Installation',
      '## Owned and borrowed lifecycle',
      '## Raw and compiled queries',
      '## Transactions',
      '## Cancellation',
      '## Errors and security',
      '## Multiple databases',
      '## Testing',
      '## Compatibility',
      '## Non-goals and roadmap',
      '## API reference',
      'bodyFailure',
      'better-sqlite3'
    ],
    'Package README'
  )
  assertRequiredText(
    changelog,
    ['## [0.1.0] - ', 'transaction bridge', 'PGlite'],
    'Kysely changelog'
  )
  await assertLinks(page, 'Kysely documentation')
  await assertLinks(index, 'Documentation index')
  for (const related of relatedDocs) {
    assertRequiredText(related.contents, ['/docs/kysely'], `${related.name} documentation`)
    await assertLinks(related.contents, `${related.name} documentation`)
  }
  for (const forbidden of [
    'all Kysely dialects certified',
    'queries are fully cancellable',
    'exactly-once transactions',
    'drop-in replacement for Kysely'
  ]) {
    assertCondition(
      !page.includes(forbidden) && !readme.includes(forbidden),
      `Unsupported promise: ${forbidden}`
    )
  }
  assertRequiredText(
    llmsIndex,
    ['llms(source).index()', "import { source } from '@/lib/source'"],
    'LLM index route'
  )
  assertRequiredText(llmsFull, ['source.getPages()', 'getLLMText'], 'Full LLM route')
  assertRequiredText(
    source,
    ["dir: 'content/docs'", 'docs.toFumadocsSource()'],
    'Documentation source'
  )

  for (const example of [
    'sqlite.ts',
    'transactions.ts',
    'borrowed-database.ts',
    'sqlite-support.ts'
  ]) {
    assertCondition(
      await Bun.file(resolve(packageRoot, 'examples', example)).exists(),
      `Missing executable example ${example}`
    )
  }
}

await assertDocs()
console.log('better-effect-kysely documentation checks passed')
