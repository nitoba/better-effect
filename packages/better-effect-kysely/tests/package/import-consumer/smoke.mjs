const module = await import('better-effect-kysely')

const expected = ['KyselyEffect', 'KyselyQueryError', 'KyselyTransactionError']
const actual = Object.keys(module).sort()
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`Unexpected import-only exports: ${actual.join(', ')}`)
}

console.log('better-effect-kysely import-only consumer passed')
