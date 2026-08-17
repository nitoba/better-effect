# Public Type Namespaces Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add declaration-only, namespaced public type helpers for Effect, Service, Layer, Runtime, and Scope without changing runtime output or removing existing prefixed exports.

**Architecture:** Merge one `export declare namespace` into each existing public runtime symbol in its defining module, with aliases delegating to current source types. Protect the API with source type tests and a built-package consumer fixture compiled by both the workspace compiler and TypeScript 5.2.2; inspect declaration and ESM graphs to prove package exposure and runtime erasure.

**Tech Stack:** TypeScript declaration merging, Bun, `bun:test` type assertions, tsdown, Oxfmt/Oxlint, Turborepo, publint.

**Design spec:** `docs/superpowers/specs/2026-08-16-public-type-namespaces-design.md`

---

## File Structure

**Create**

- `packages/better-effect/tests/types/public-type-namespaces.types.ts` — source-level exact alias and generic contract tests.
- `packages/better-effect/tests/package/public-type-namespaces/valid.ts` — valid external-style package consumer covering every alias.
- `packages/better-effect/tests/package/public-type-namespaces/invalid-runtime.ts` — intentionally invalid Runtime program used to inspect literal diagnostics.
- `packages/better-effect/tests/package/public-type-namespaces/tsconfig.json` — isolated current/minimum compiler fixture.
- `packages/better-effect/tests/package/public-type-namespaces/tsconfig.diagnostic.json` — diagnostic-only fixture configuration.
- `packages/better-effect/tests/package/public-type-namespaces/check.ts` — declaration graph, ESM graph, runtime property, and diagnostic assertions.
- `packages/better-effect/examples/todo-api/tsconfig.json` — focused typecheck for the executable integration example.

**Modify**

- `packages/better-effect/src/effect/effect.ts` — merge Effect type aliases into the Effect value.
- `packages/better-effect/src/service/service.ts` — merge Service type aliases into the Service function.
- `packages/better-effect/src/layer/layer.ts` — merge Layer type aliases into the Layer class.
- `packages/better-effect/src/runtime/runtime.ts` — merge Runtime type aliases into the Runtime class.
- `packages/better-effect/src/scope/scope.ts` — merge Scope type aliases into the Scope value/interface family.
- `packages/better-effect/tsconfig.json` — keep intentionally invalid external fixtures out of the normal source typecheck.
- `packages/better-effect/package.json` — add package-consumer checks and include them after build in the package `check` command.
- `.github/workflows/ci.yml` — run package namespace checks after build.
- `packages/better-effect/README.md` — document associated type helpers and compatibility spellings.
- `apps/docs/content/docs/effects.mdx` — recommend `Effect.*` aliases.
- `apps/docs/content/docs/services.mdx` — recommend `Service.*` and `Effect.Requirements` aliases.
- `apps/docs/content/docs/layers.mdx` — recommend `Layer.*` aliases.
- `apps/docs/content/docs/runtime.mdx` — recommend `Runtime.For`.
- `apps/docs/content/docs/scope.mdx` — recommend `Scope.*` aliases.
- `apps/docs/content/docs/troubleshooting.mdx` — use namespaced Layer diagnostics.
- `packages/better-effect/examples/todo-api/better-effect.ts` — remove the example-only `RuntimeFor` reexport.
- `packages/better-effect/examples/todo-api/server.ts` — use `Runtime.For<typeof AppLive>`.
- `AGENTS.md` — recognize the preferred namespaced spelling and compatible top-level spelling.

## Chunk 1: Public Type API

### Task 0: Record the pre-existing lint baseline

**Files:**

- Inspect only; do not modify unrelated lint failures.

- [ ] **Step 1: Capture the package lint baseline before implementation**

```bash
cd packages/better-effect
bunx oxlint --type-aware . --format json > /tmp/better-effect-lint-before.json || true
bun run lint
```

Expected: the full lint command FAILS on the already-known anti-slop baseline. Save `/tmp/better-effect-lint-before.json` for comparison and do not fix unrelated diagnostics in this feature.

- [ ] **Step 2: Confirm the source typecheck baseline is green**

```bash
bun run typecheck
```

Expected: PASS before adding the failing namespace test.

### Task 1: Add the failing source type contract

**Files:**

- Create: `packages/better-effect/tests/types/public-type-namespaces.types.ts`

- [ ] **Step 1: Create the compile-time test before changing production code**

```ts
import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import {
  Effect,
  Layer,
  Runtime,
  Scope,
  Service,
  type AnyEffectResult,
  type AnyServiceToken,
  type CloseableScope,
  type DisposableResource,
  type EffectError,
  type EffectRequirements,
  type EffectSuccess,
  type LayerMissing,
  type LayerProvided,
  type LayerRawRequired,
  type LayerSpecs,
  type RuntimeFor,
  type RuntimeOptions,
  type RuntimeShutdownDiagnostic,
  type ScopeFinalizer,
  type ScopeOutcome,
  type ServiceClass,
  type ServiceInstance,
  type ServiceRequirements,
  type ServiceTag,
  type ServiceToken
} from '../../src'

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'query'
  }
}

class Repository extends Service<Repository>()('Repository') {
  load() {
    return Effect.gen(async function* () {
      const database = yield* Database

      return Result.ok(database.query())
    })
  }
}

const program = Effect.gen(async function* () {
  const repository = yield* Repository

  return Result.ok(repository)
})

const DatabaseLive = Layer.succeed(Database, new Database())
const RepositoryLive = Layer.make(Repository)
const AppLive = Layer.merge(DatabaseLive, RepositoryLive)

expectTypeOf<Effect.Success<typeof program>>().toEqualTypeOf<EffectSuccess<typeof program>>()
expectTypeOf<Effect.Error<typeof program>>().toEqualTypeOf<EffectError<typeof program>>()
expectTypeOf<Effect.Requirements<typeof program>>().toEqualTypeOf<
  EffectRequirements<typeof program>
>()
expectTypeOf<Effect.AnyResult>().toEqualTypeOf<AnyEffectResult>()

expectTypeOf<Service.Any>().toEqualTypeOf<AnyServiceToken>()
expectTypeOf<Service.Token>().toEqualTypeOf<ServiceToken>()
expectTypeOf<Service.Token<'Database', Database>>().toEqualTypeOf<
  ServiceToken<'Database', Database>
>()
expectTypeOf<Service.Class>().toEqualTypeOf<ServiceClass>()
expectTypeOf<Service.Class<'Database', Database>>().toEqualTypeOf<
  ServiceClass<'Database', Database>
>()
expectTypeOf<Service.Instance<typeof Database>>().toEqualTypeOf<ServiceInstance<typeof Database>>()
expectTypeOf<Service.Tag<typeof Database>>().toEqualTypeOf<ServiceTag<typeof Database>>()
expectTypeOf<Service.Requirements<typeof Repository>>().toEqualTypeOf<
  ServiceRequirements<typeof Repository>
>()

expectTypeOf<Layer.Any>().toEqualTypeOf<Layer<any, any>>()
expectTypeOf<Layer.Specs<typeof AppLive>>().toEqualTypeOf<LayerSpecs<typeof AppLive>>()
expectTypeOf<Layer.Provided<typeof AppLive>>().toEqualTypeOf<LayerProvided<typeof AppLive>>()
expectTypeOf<Layer.Required<typeof AppLive>>().toEqualTypeOf<LayerRawRequired<typeof AppLive>>()
expectTypeOf<Layer.Missing<typeof AppLive>>().toEqualTypeOf<LayerMissing<typeof AppLive>>()
expectTypeOf<Layer.Complete<typeof AppLive>>().toEqualTypeOf<typeof AppLive>()

expectTypeOf<Runtime.For<typeof AppLive>>().toEqualTypeOf<RuntimeFor<typeof AppLive>>()
expectTypeOf<Runtime.Options>().toEqualTypeOf<RuntimeOptions>()
expectTypeOf<Runtime.ShutdownDiagnostic>().toEqualTypeOf<RuntimeShutdownDiagnostic>()

expectTypeOf<Scope.Closeable>().toEqualTypeOf<CloseableScope>()
expectTypeOf<Scope.Outcome>().toEqualTypeOf<ScopeOutcome>()
expectTypeOf<Scope.Finalizer>().toEqualTypeOf<ScopeFinalizer>()
expectTypeOf<Scope.Disposable>().toEqualTypeOf<DisposableResource>()

// @ts-expect-error Service tags are strings.
expectTypeOf<Service.Token<42>>()
// @ts-expect-error Service instance helpers require a Service token.
expectTypeOf<Service.Instance<object>>()
// @ts-expect-error Layer helpers require a Layer.
expectTypeOf<Layer.Provided<object>>()
// @ts-expect-error Runtime.For requires a Layer.
expectTypeOf<Runtime.For<object>>()
```

- [ ] **Step 2: Run the package typecheck and verify RED**

Run:

```bash
cd packages/better-effect
bun run typecheck
```

Expected: FAIL only because `Effect`, `Service`, `Layer`, `Runtime`, and `Scope` do not yet expose the tested type members. Confirm the `@ts-expect-error` directives are not the source of unrelated failures.

### Task 2: Add declaration-only namespace aliases

**Files:**

- Modify: `packages/better-effect/src/effect/effect.ts`
- Modify: `packages/better-effect/src/service/service.ts`
- Modify: `packages/better-effect/src/layer/layer.ts`
- Modify: `packages/better-effect/src/runtime/runtime.ts`
- Modify: `packages/better-effect/src/scope/scope.ts`

- [ ] **Step 1: Expand type-only imports in `effect/effect.ts`**

Replace the `./types` import with:

```ts
import type {
  AnyEffectResult,
  EffectError,
  EffectFromGenerator,
  EffectRequirements,
  EffectSuccess,
  EffectYield
} from './types'
```

- [ ] **Step 2: Merge the Effect namespace after the `Effect` object**

```ts
/** Type helpers associated with Effect programs. */
export declare namespace Effect {
  /** Extract an Effect program's successful value. */
  export type Success<T> = EffectSuccess<T>

  /** Extract an Effect program's error value. */
  export type Error<T> = EffectError<T>

  /** Extract an Effect program's required Services. */
  export type Requirements<T> = EffectRequirements<T>

  /** Any Effect result shape accepted by generic Effect helpers. */
  export type AnyResult = AnyEffectResult
}
```

- [ ] **Step 3: Expand type-only imports in `service/service.ts`**

Replace the `./types` import with:

```ts
import type {
  AnyServiceToken,
  ServiceClass,
  ServiceInstance,
  ServiceRequirements,
  ServiceTag,
  ServiceToken
} from './types'
```

- [ ] **Step 4: Merge the Service namespace after the `Service` function**

```ts
/** Type helpers associated with Service tokens. */
export declare namespace Service {
  /** Any Service token accepted by generic Service infrastructure. */
  export type Any = AnyServiceToken

  /** A class constructor carrying a Service tag and instance contract. */
  export type Token<Tag extends string = string, Instance = any> = ServiceToken<Tag, Instance>

  /** A concrete Service class accepted by Layer providers. */
  export type Class<Tag extends string = string, Instance = any> = ServiceClass<Tag, Instance>

  /** Extract the instance represented by a Service token. */
  export type Instance<T extends AnyServiceToken> = ServiceInstance<T>

  /** Extract the literal identity tag represented by a Service token. */
  export type Tag<T extends AnyServiceToken> = ServiceTag<T>

  /** Extract Services required by a Service contract's Effect-returning methods. */
  export type Requirements<T extends AnyServiceToken> = ServiceRequirements<T>
}
```

- [ ] **Step 5: Expand the inference import in `layer/layer.ts`**

Replace the current `./inference` import with:

```ts
import type {
  AnyLayer,
  CompleteLayer,
  LayerMissing,
  LayerProvided,
  LayerRawRequired,
  LayerSpecs,
  OverrideLayerCollisions,
  OverrideLayerSpecs
} from './inference'
```

- [ ] **Step 6: Merge the Layer namespace after the Layer class**

```ts
/** Type helpers associated with Layer environments. */
export declare namespace Layer {
  /** Any Layer shape accepted by generic Layer helpers. */
  export type Any = AnyLayer

  /** Extract a Layer's provider specification union. */
  export type Specs<L extends AnyLayer> = LayerSpecs<L>

  /** Extract the Service union provided by a Layer. */
  export type Provided<L extends AnyLayer> = LayerProvided<L>

  /** Extract all raw Service requirements declared by a Layer. */
  export type Required<L extends AnyLayer> = LayerRawRequired<L>

  /** Extract the Service requirements missing from a Layer. */
  export type Missing<L extends AnyLayer> = LayerMissing<L>

  /** Validate a Layer for complete-Layer execution boundaries. */
  export type Complete<L extends AnyLayer> = CompleteLayer<L>
}
```

- [ ] **Step 7: Expand Runtime type-only imports**

In `runtime/runtime.ts`, import `RuntimeShutdownDiagnostic` with `RuntimeOptions`:

```ts
import {
  classifyRuntimeOutcome,
  type RuntimeOptions,
  type RuntimeShutdownDiagnostic
} from './outcome'
```

Add:

```ts
import type { RuntimeFor } from './types'
```

- [ ] **Step 8: Merge the Runtime namespace after the Runtime class**

```ts
/** Type helpers associated with Runtime environments and shutdown. */
export declare namespace Runtime {
  /** Name the Runtime inferred from a concrete Layer. */
  export type For<L extends AnyLayer> = RuntimeFor<L>

  /** Runtime construction and cleanup-observer options. */
  export type Options = RuntimeOptions

  /** Aggregated cleanup information reported during Runtime shutdown. */
  export type ShutdownDiagnostic = RuntimeShutdownDiagnostic
}
```

- [ ] **Step 9: Merge the Scope namespace after the Scope object**

`CloseableScope` is already declared in `scope/scope.ts`; the other source types are already imported. Add:

```ts
/** Type helpers associated with Scope ownership and finalization. */
export declare namespace Scope {
  /** A Scope whose owner is responsible for closure. */
  export type Closeable = CloseableScope

  /** Final outcome supplied to Scope finalizers. */
  export type Outcome = ScopeOutcome

  /** Cleanup callback registered with a Scope. */
  export type Finalizer = ScopeFinalizer

  /** A value supporting synchronous or asynchronous disposal. */
  export type Disposable = DisposableResource
}
```

- [ ] **Step 10: Run Oxfmt on changed TypeScript files**

Run from the repository root:

```bash
bunx oxfmt --write \
  packages/better-effect/src/effect/effect.ts \
  packages/better-effect/src/service/service.ts \
  packages/better-effect/src/layer/layer.ts \
  packages/better-effect/src/runtime/runtime.ts \
  packages/better-effect/src/scope/scope.ts \
  packages/better-effect/tests/types/public-type-namespaces.types.ts
```

- [ ] **Step 11: Verify GREEN with the package typecheck**

```bash
cd packages/better-effect
bun run typecheck
```

Expected: PASS. Existing top-level type exports remain untouched in all barrel files.

- [ ] **Step 12: Lint the new test and inspect the known package baseline**

```bash
bunx oxlint --type-aware tests/types/public-type-namespaces.types.ts
bunx oxlint --type-aware . --format json > /tmp/better-effect-lint-after-source.json || true
bun run lint
```

Expected: the focused new-file lint PASS. The full lint still FAILS only on the pre-existing anti-slop baseline; inspect the output and confirm no diagnostic points to a newly added namespace declaration, alias, import, or source test line. Do not fix unrelated baseline diagnostics.

- [ ] **Step 13: Commit the source API and source tests**

```bash
git add \
  packages/better-effect/src/effect/effect.ts \
  packages/better-effect/src/service/service.ts \
  packages/better-effect/src/layer/layer.ts \
  packages/better-effect/src/runtime/runtime.ts \
  packages/better-effect/src/scope/scope.ts \
  packages/better-effect/tests/types/public-type-namespaces.types.ts
git commit -m "feat: add public type namespaces"
```

## Chunk 2: Built-Package Compatibility and CI

### Task 3: Add external-style package consumer fixtures

**Files:**

- Create: `packages/better-effect/tests/package/public-type-namespaces/valid.ts`
- Create: `packages/better-effect/tests/package/public-type-namespaces/invalid-runtime.ts`
- Create: `packages/better-effect/tests/package/public-type-namespaces/tsconfig.json`
- Create: `packages/better-effect/tests/package/public-type-namespaces/tsconfig.diagnostic.json`
- Modify: `packages/better-effect/tsconfig.json`

- [ ] **Step 1: Create `valid.ts` using only bare package imports**

```ts
import { Result } from 'better-result'

import {
  Effect,
  Layer,
  Runtime,
  Scope,
  Service,
  type AnyEffectResult,
  type AnyServiceToken,
  type CloseableScope,
  type DisposableResource,
  type EffectError,
  type EffectRequirements,
  type EffectSuccess,
  type LayerMissing,
  type LayerProvided,
  type LayerRawRequired,
  type LayerSpecs,
  type RuntimeFor,
  type RuntimeOptions,
  type RuntimeShutdownDiagnostic,
  type ScopeFinalizer,
  type ScopeOutcome,
  type ServiceClass,
  type ServiceInstance,
  type ServiceRequirements,
  type ServiceTag,
  type ServiceToken
} from 'better-effect'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false

type Expect<Value extends true> = Value

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'query'
  }
}

class Repository extends Service<Repository>()('Repository') {
  load() {
    return Effect.gen(async function* () {
      const database = yield* Database

      return Result.ok(database.query())
    })
  }
}

const makeProgram = () =>
  Effect.gen(async function* () {
    const repository = yield* Repository

    return Result.ok(repository)
  })

const DatabaseLive = Layer.succeed(Database, new Database())
const RepositoryLive = Layer.make(Repository)
const AppLive = Layer.merge(DatabaseLive, RepositoryLive)

type Program = ReturnType<typeof makeProgram>

export type EffectSuccessAlias = Expect<Equal<Effect.Success<Program>, EffectSuccess<Program>>>
export type EffectErrorAlias = Expect<Equal<Effect.Error<Program>, EffectError<Program>>>
export type EffectRequirementsAlias = Expect<
  Equal<Effect.Requirements<Program>, EffectRequirements<Program>>
>
export type EffectAnyAlias = Expect<Equal<Effect.AnyResult, AnyEffectResult>>

export type ServiceAnyAlias = Expect<Equal<Service.Any, AnyServiceToken>>
export type ServiceTokenDefault = Expect<Equal<Service.Token, ServiceToken>>
export type ServiceTokenAlias = Expect<
  Equal<Service.Token<'Database', Database>, ServiceToken<'Database', Database>>
>
export type ServiceClassDefault = Expect<Equal<Service.Class, ServiceClass>>
export type ServiceClassAlias = Expect<
  Equal<Service.Class<'Database', Database>, ServiceClass<'Database', Database>>
>
export type ServiceInstanceAlias = Expect<
  Equal<Service.Instance<typeof Database>, ServiceInstance<typeof Database>>
>
export type ServiceTagAlias = Expect<
  Equal<Service.Tag<typeof Database>, ServiceTag<typeof Database>>
>
export type ServiceRequirementsAlias = Expect<
  Equal<Service.Requirements<typeof Repository>, ServiceRequirements<typeof Repository>>
>

export type LayerAnyAlias = Expect<Equal<Layer.Any, Layer<any, any>>>
export type LayerSpecsAlias = Expect<Equal<Layer.Specs<typeof AppLive>, LayerSpecs<typeof AppLive>>>
export type LayerProvidedAlias = Expect<
  Equal<Layer.Provided<typeof AppLive>, LayerProvided<typeof AppLive>>
>
export type LayerRequiredAlias = Expect<
  Equal<Layer.Required<typeof AppLive>, LayerRawRequired<typeof AppLive>>
>
export type LayerMissingAlias = Expect<
  Equal<Layer.Missing<typeof AppLive>, LayerMissing<typeof AppLive>>
>
export type LayerCompleteAlias = Expect<Equal<Layer.Complete<typeof AppLive>, typeof AppLive>>

export type RuntimeForAlias = Expect<Equal<Runtime.For<typeof AppLive>, RuntimeFor<typeof AppLive>>>
export type RuntimeEnvironmentAlias = Expect<
  Equal<Runtime.For<typeof AppLive>, Runtime<Layer.Provided<typeof AppLive>>>
>
export type RuntimeOptionsAlias = Expect<Equal<Runtime.Options, RuntimeOptions>>
export type RuntimeDiagnosticAlias = Expect<
  Equal<Runtime.ShutdownDiagnostic, RuntimeShutdownDiagnostic>
>

export type ScopeCloseableAlias = Expect<Equal<Scope.Closeable, CloseableScope>>
export type ScopeOutcomeAlias = Expect<Equal<Scope.Outcome, ScopeOutcome>>
export type ScopeFinalizerAlias = Expect<Equal<Scope.Finalizer, ScopeFinalizer>>
export type ScopeDisposableAlias = Expect<Equal<Scope.Disposable, DisposableResource>>
```

- [ ] **Step 2: Create `invalid-runtime.ts` without suppressing the expected error**

```ts
import { Result } from 'better-result'

import { Effect, Layer, Runtime, Service, type LayerBackend } from 'better-effect'

class Database extends Service<Database>()('Database') {}
class Cache extends Service<Cache>()('Cache') {}

const DatabaseLive = Layer.succeed(Database, new Database())

declare const backend: LayerBackend

const needsCache = () =>
  Effect.gen(async function* () {
    const cache = yield* Cache

    return Result.ok(cache)
  })

const invalidProgram = Object.assign(needsCache, {
  __betterEffectMissingRuntimeService__Cache: 'invalid'
})

void Runtime.run(DatabaseLive, backend, invalidProgram)
```

- [ ] **Step 3: Create the standalone valid fixture `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "ESNext.Disposable"],
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": []
  },
  "files": ["valid.ts"]
}
```

`DOM` supplies `AbortSignal` used by `better-result`. `skipLibCheck: true` keeps the TypeScript 5.2 check focused on `better-effect` consumer declarations because `better-result@3` itself references the TypeScript 5.4 `NoInfer` intrinsic.

- [ ] **Step 4: Create `tsconfig.diagnostic.json`**

```json
{
  "extends": "./tsconfig.json",
  "files": ["invalid-runtime.ts"]
}
```

- [ ] **Step 5: Exclude external fixtures from the normal source typecheck**

Add this top-level property to `packages/better-effect/tsconfig.json`:

```json
"exclude": ["tests/package"]
```

Keep `include: ["src", "tests"]`; the entire external fixture directory is excluded because it requires built package declarations, and `invalid-runtime.ts` must additionally fail in its dedicated compiler invocation.

### Task 4: Add artifact and diagnostic validation

**Files:**

- Create: `packages/better-effect/tests/package/public-type-namespaces/check.ts`
- Modify: `packages/better-effect/package.json`

- [ ] **Step 1: Create `check.ts`**

```ts
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url))
const distRoot = join(packageRoot, 'dist')
const rootDeclaration = join(distRoot, 'index.d.mts')

const collectFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)))
    } else {
      files.push(path)
    }
  }

  return files
}

const assertCondition = (condition: boolean, message: string): asserts condition => {
  if (!condition) {
    throw new Error(message)
  }
}

const readDeclarationGraph = async (entry: string): Promise<string> => {
  const visited = new Set<string>()
  const sources: string[] = []

  const visit = async (path: string): Promise<void> => {
    if (visited.has(path)) {
      return
    }

    visited.add(path)

    const source = await readFile(path, 'utf8')
    sources.push(source)

    const localImports = source.matchAll(/\\bfrom\\s+["'](\\.\\/[^"']+\\.mjs)["']/g)

    for (const match of localImports) {
      const specifier = match[1]

      assertCondition(specifier !== undefined, `Invalid declaration import in ${path}`)

      const declarationPath = join(
        dirname(path),
        specifier.slice(2).replace(/\\.mjs$/, '.d.mts')
      )

      await visit(declarationPath)
    }
  }

  await visit(entry)

  return sources.join('\n')
}

const aliases: Record<string, readonly string[]> = {
  Effect: ['Success', 'Error', 'Requirements', 'AnyResult'],
  Service: ['Any', 'Token', 'Class', 'Instance', 'Tag', 'Requirements'],
  Layer: ['Any', 'Specs', 'Provided', 'Required', 'Missing', 'Complete'],
  Runtime: ['For', 'Options', 'ShutdownDiagnostic'],
  Scope: ['Closeable', 'Outcome', 'Finalizer', 'Disposable']
}

const files = await collectFiles(distRoot)
const esmFiles = files.filter((path) => path.endsWith('.mjs'))

assertCondition(esmFiles.length > 0, 'No generated .mjs files were found')

const declarations = await readDeclarationGraph(rootDeclaration)
const esm = (await Promise.all(esmFiles.map((path) => readFile(path, 'utf8')))).join('\n')

for (const [namespaceName, members] of Object.entries(aliases)) {
  const namespaceMatch = declarations.match(
    new RegExp(`declare namespace ${namespaceName}\\s*\\{([\\s\\S]*?)\\n\\}`)
  )

  assertCondition(namespaceMatch !== null, `Missing declaration namespace ${namespaceName}`)

  const namespaceBody = namespaceMatch[1]

  assertCondition(namespaceBody !== undefined, `Missing body for namespace ${namespaceName}`)

  for (const member of members) {
    const aliasPattern = new RegExp(`\\btype\\s+${member}(?:\\s*<|\\s*=)`)

    assertCondition(
      aliasPattern.test(namespaceBody),
      `Missing declaration alias ${namespaceName}.${member}`
    )

    const assignmentPattern = new RegExp(
      `\\b${namespaceName}\\s*(?:\\.${member}|\\[["']${member}["']\\])\\s*=`
    )

    assertCondition(
      !assignmentPattern.test(esm),
      `Unexpected runtime assignment for ${namespaceName}.${member}`
    )
  }

  const namespaceIifePattern = new RegExp(`\\(function\\s*\\(\\s*${namespaceName}\\s*\\)`)

  assertCondition(!namespaceIifePattern.test(esm), `Unexpected namespace IIFE for ${namespaceName}`)
}

const built = await import(pathToFileURL(join(distRoot, 'index.mjs')).href)
const runtimeNamespaces = new Map<string, object>([
  ['Effect', built.Effect],
  ['Service', built.Service],
  ['Layer', built.Layer],
  ['Runtime', built.Runtime],
  ['Scope', built.Scope]
])

for (const [namespaceName, members] of Object.entries(aliases)) {
  const value = runtimeNamespaces.get(namespaceName)

  assertCondition(value !== undefined, `Missing runtime export ${namespaceName}`)

  for (const member of members) {
    assertCondition(
      !Object.prototype.hasOwnProperty.call(value, member),
      `Type alias leaked to runtime as ${namespaceName}.${member}`
    )
  }
}

const diagnostic = Bun.spawnSync(
  ['bun', 'x', 'tsc', '-p', 'tests/package/public-type-namespaces/tsconfig.diagnostic.json'],
  {
    cwd: packageRoot,
    stdout: 'pipe',
    stderr: 'pipe'
  }
)
const decoder = new TextDecoder()
const diagnosticOutput = `${decoder.decode(diagnostic.stdout)}\n${decoder.decode(diagnostic.stderr)}`

assertCondition(diagnostic.exitCode !== 0, 'Invalid Runtime fixture unexpectedly typechecked')
assertCondition(
  diagnosticOutput.includes('__betterEffectMissingRuntimeService__Cache'),
  'Runtime diagnostic did not preserve the literal Cache tag'
)

console.log('Public type namespace package checks passed')
```

During implementation, adjust only formatting or Bun API details if the installed Bun types require it; do not weaken any assertion.

- [ ] **Step 2: Add package scripts**

Add to `packages/better-effect/package.json`:

```json
"test:package-types": "tsc -p tests/package/public-type-namespaces/tsconfig.json",
"test:package-types:minimum": "bunx --bun --package typescript@5.2.2 tsc --version && bunx --bun --package typescript@5.2.2 tsc -p tests/package/public-type-namespaces/tsconfig.json",
"check:public-type-namespaces": "bun run test:package-types && bun run test:package-types:minimum && bun tests/package/public-type-namespaces/check.ts"
```

Update the existing package `check` script so all feature-relevant checks run before the known repository lint baseline fails:

```json
"check": "bun run typecheck && bun test && bun run format && bun run build && bun run check:public-type-namespaces && bun run publint && bun run lint"
```

The final lint position is temporary baseline accommodation, not a suppression: the command still fails on existing violations, but only after type, test, build, package, and publint checks execute.

- [ ] **Step 3: Format fixture and configuration files**

Run:

```bash
bunx oxfmt --write \
  packages/better-effect/tests/package/public-type-namespaces \
  packages/better-effect/tsconfig.json \
  packages/better-effect/package.json
```

- [ ] **Step 4: Build and run package checks**

Run:

```bash
cd packages/better-effect
bun run build
bun run check:public-type-namespaces
```

Expected:

- current compiler fixture PASS;
- output includes `Version 5.2.2`;
- TypeScript 5.2.2 fixture PASS;
- invalid Runtime fixture exits non-zero internally and its Cache diagnostic is accepted;
- checker prints `Public type namespace package checks passed`.

If the valid self-reference resolves `src` instead of `dist`, stop and fix fixture module resolution/package invocation. Do not add a source path alias.

### Task 5: Add the post-build CI boundary

**Files:**

- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Move the existing lint step to the end of the quality job**

Remove the current `Lint` block immediately after `Typecheck` and re-add the unchanged block immediately after `Inspect package contents`:

```yaml
- name: Lint
  run: bun run lint
```

This does not suppress the known baseline: lint remains a failing CI boundary, but it no longer prevents build and package-specific validation from executing.

- [ ] **Step 2: Add a step immediately after `Build`**

```yaml
- name: Validate public type namespaces
  working-directory: packages/better-effect
  run: bun run check:public-type-namespaces
```

Keep `Validate package` and `Inspect package contents` after this step, followed by the moved final `Lint` step.

- [ ] **Step 3: Format the workflow**

```bash
bunx oxfmt --write .github/workflows/ci.yml
bunx oxfmt --check .github/workflows/ci.yml
```

Expected: formatting check PASS.

- [ ] **Step 4: Lint newly created package fixture files**

```bash
cd packages/better-effect
bunx oxlint --type-aware tests/package/public-type-namespaces
```

Expected: PASS with no diagnostics from the new fixtures or checker.

- [ ] **Step 5: Run focused package validation**

```bash
bun run typecheck
bun run build
bun run check:public-type-namespaces
bun run publint
bun pm pack --dry-run
```

Expected: all commands PASS and dry-run package contents include `dist/index.d.mts`.

- [ ] **Step 6: Commit package compatibility coverage**

```bash
git add \
  .github/workflows/ci.yml \
  packages/better-effect/package.json \
  packages/better-effect/tsconfig.json \
  packages/better-effect/tests/package/public-type-namespaces
git commit -m "test: validate public type namespace artifacts"
```

## Chunk 3: Documentation and Example

### Task 6: Document namespaced helpers

**Files:**

- Modify: `packages/better-effect/README.md`
- Modify: `apps/docs/content/docs/effects.mdx`
- Modify: `apps/docs/content/docs/services.mdx`
- Modify: `apps/docs/content/docs/layers.mdx`
- Modify: `apps/docs/content/docs/runtime.mdx`
- Modify: `apps/docs/content/docs/scope.mdx`
- Modify: `apps/docs/content/docs/troubleshooting.mdx`

- [ ] **Step 1: Add a README section after the “typechecked wiring” introduction**

Add a concise section containing this canonical example:

````md
### Discover type helpers from their API

Public type helpers are also grouped under the runtime API they describe:

```ts
import { Effect, Layer, Runtime, Scope, Service } from 'better-effect'

type Program = ReturnType<UserRepository['findUser']>
type Success = Effect.Success<Program>
type Failure = Effect.Error<Program>
type Dependencies = Effect.Requirements<Program>
type Services = Layer.Provided<typeof AppLive>
type AppRuntime = Runtime.For<typeof AppLive>
type DatabaseTag = Service.Tag<typeof Database>
type Outcome = Scope.Outcome
```

These are declaration-only aliases and add nothing to the JavaScript bundle.
The existing prefixed spellings—including `EffectSuccess`,
`EffectRequirements`, `LayerProvided`, `RuntimeFor`, `ServiceTag` and
`ScopeOutcome`—remain public and are not deprecated.
````

- [ ] **Step 2: Replace the inference example in `effects.mdx`**

Use:

```ts
type Program = typeof loadDashboard
type Success = Effect.Success<Program>
type Failure = Effect.Error<Program>
type Needs = Effect.Requirements<Program>
```

Follow it with one sentence stating that `EffectSuccess`, `EffectError`, and `EffectRequirements` remain compatible top-level spellings.

- [ ] **Step 3: Update `services.mdx`**

Replace the top-level `EffectRequirements` import/example with:

```ts
type Requirements = Effect.Requirements<typeof readUser>
// Database

type DatabaseInstance = Service.Instance<typeof Database>
type DatabaseTag = Service.Tag<typeof Database>
```

State that these aliases are type-only and `Service.Requirements<T>` exposes dependencies derived from a Service contract's methods.

- [ ] **Step 4: Replace the Layer helper block in `layers.mdx`**

```ts
type Provided = Layer.Provided<typeof ApplicationLive>
type RequiredDuringAcquire = Layer.Required<typeof ApplicationLive>
type Missing = Layer.Missing<typeof ApplicationLive>
type Specs = Layer.Specs<typeof ApplicationLive>
type Complete = Layer.Complete<typeof ApplicationLive>
```

State that `LayerProvided`, `LayerRawRequired`, `LayerMissing`, and `LayerSpecs` remain compatible top-level exports. Do not claim that source-only `AnyLayer` or `CompleteLayer` are package-root exports.

- [ ] **Step 5: Replace `RuntimeFor` guidance in `runtime.mdx`**

Use:

```ts
type AppRuntime = Runtime.For<typeof AppLive>

export function createServer(runtime: AppRuntime) {
  return {
    handle: () => runtime.run(() => needsDatabase)
  }
}
```

State that `RuntimeFor<typeof AppLive>` remains an equivalent compatibility spelling and that unparameterized `Runtime` still intentionally erases environment precision.

- [ ] **Step 6: Add Scope associated-type guidance in `scope.mdx`**

Immediately before the finalizer example, explain that finalizers receive `Scope.Outcome`, then show an explicit reusable type:

```ts
const observeOutcome = (outcome: Scope.Outcome) => {
  console.log('scope ended with', outcome.status)
}
```

Mention `Scope.Closeable`, `Scope.Finalizer`, and `Scope.Disposable`, and state that `CloseableScope`, `ScopeFinalizer`, `DisposableResource`, and `ScopeOutcome` remain available.

- [ ] **Step 7: Update the troubleshooting checklist**

Change item 2 to:

```md
2. Inspect `Layer.Provided`, `Layer.Required` and `Layer.Missing` when a
   composition root fails to typecheck.
```

- [ ] **Step 8: Format documentation**

```bash
bunx oxfmt --write \
  packages/better-effect/README.md \
  apps/docs/content/docs/effects.mdx \
  apps/docs/content/docs/services.mdx \
  apps/docs/content/docs/layers.mdx \
  apps/docs/content/docs/runtime.mdx \
  apps/docs/content/docs/scope.mdx \
  apps/docs/content/docs/troubleshooting.mdx
bunx oxfmt --check \
  packages/better-effect/README.md \
  apps/docs/content/docs/effects.mdx \
  apps/docs/content/docs/services.mdx \
  apps/docs/content/docs/layers.mdx \
  apps/docs/content/docs/runtime.mdx \
  apps/docs/content/docs/scope.mdx \
  apps/docs/content/docs/troubleshooting.mdx
```

### Task 7: Update the TODO example and project guidance

**Files:**

- Create: `packages/better-effect/examples/todo-api/tsconfig.json`
- Modify: `packages/better-effect/examples/todo-api/better-effect.ts`
- Modify: `packages/better-effect/examples/todo-api/server.ts`
- Modify: `packages/better-effect/package.json`
- Modify: `AGENTS.md`

- [ ] **Step 1: Remove the example-only `RuntimeFor` reexport**

`packages/better-effect/examples/todo-api/better-effect.ts` should become:

```ts
export { Effect, Layer, Resource, Scope, Service, ServiceRuntime, Runtime } from '../../src/index'

export { ItiLayerBackend } from '../../src/adapters/iti'
```

- [ ] **Step 2: Use the associated Runtime type in `server.ts`**

Replace:

```ts
import { Effect, type RuntimeFor } from './better-effect'
```

with:

```ts
import { Effect, Runtime } from './better-effect'
```

Replace:

```ts
type AppRuntime = RuntimeFor<typeof AppLive>
```

with:

```ts
type AppRuntime = Runtime.For<typeof AppLive>
```

- [ ] **Step 3: Add a focused TypeScript project for the TODO example**

Create `packages/better-effect/examples/todo-api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["**/*.ts"]
}
```

Add this package script:

```json
"typecheck:example": "tsc -p examples/todo-api/tsconfig.json"
```

Update the package `check` script to run `bun run typecheck:example` immediately after `bun run typecheck`, before build and the known final lint baseline.

- [ ] **Step 4: Run the new example typecheck and confirm the existing optional-property failure**

```bash
cd packages/better-effect
bun run typecheck:example
```

Expected: FAIL with `TS2379` at the PATCH handler because `title: input.title?.trim()` creates a present `string | undefined` property under `exactOptionalPropertyTypes`.

- [ ] **Step 5: Preserve omission while normalizing an optional title**

In the PATCH handler, replace the inline spread passed to `todos.update` with:

```ts
const normalizedInput = input.title === undefined ? input : { ...input, title: input.title.trim() }

const todo = yield * Result.await(todos.update(userId, request.params.id, normalizedInput))
```

This is a focused compatibility fix exposed by typechecking the existing example; it preserves the omitted-property contract instead of weakening compiler options.

- [ ] **Step 6: Update the typed execution guidance in `AGENTS.md`**

Replace the current `RuntimeFor`-only paragraph with:

```md
Use `Runtime.For<typeof AppLive>` when a Runtime inferred from a concrete Layer
must be named in an application boundary. It is a type-only alias for
`Runtime<Layer.Provided<typeof AppLive>>` and must preserve the same execution
checks. The compatible top-level spellings `RuntimeFor<typeof AppLive>` and
`LayerProvided<typeof AppLive>` remain public and equivalent.
```

- [ ] **Step 7: Format and validate docs/example**

```bash
bunx oxfmt --write \
  packages/better-effect/examples/todo-api/better-effect.ts \
  packages/better-effect/examples/todo-api/server.ts \
  packages/better-effect/examples/todo-api/tsconfig.json \
  packages/better-effect/package.json \
  AGENTS.md
bunx oxfmt --check \
  packages/better-effect/examples/todo-api/better-effect.ts \
  packages/better-effect/examples/todo-api/server.ts \
  packages/better-effect/examples/todo-api/tsconfig.json \
  packages/better-effect/package.json \
  AGENTS.md
bun run typecheck
cd packages/better-effect
bun run typecheck:example
cd ../..
bun run docs:build
```

Expected: focused formatting, monorepo typecheck, TODO example typecheck, and documentation build PASS.

- [ ] **Step 8: Commit documentation and example updates**

```bash
git add \
  AGENTS.md \
  packages/better-effect/README.md \
  packages/better-effect/examples/todo-api/better-effect.ts \
  packages/better-effect/examples/todo-api/server.ts \
  packages/better-effect/examples/todo-api/tsconfig.json \
  packages/better-effect/package.json \
  apps/docs/content/docs/effects.mdx \
  apps/docs/content/docs/services.mdx \
  apps/docs/content/docs/layers.mdx \
  apps/docs/content/docs/runtime.mdx \
  apps/docs/content/docs/scope.mdx \
  apps/docs/content/docs/troubleshooting.mdx
git commit -m "docs: document public type namespaces"
```

## Chunk 4: Final Verification

### Task 8: Run the complete release-quality checks

**Files:**

- Verify all files changed by Tasks 1–7.

- [ ] **Step 1: Inspect the complete branch diff**

```bash
git status --short
git diff --check origin/main...HEAD
git diff --name-status origin/main...HEAD
```

Expected: no whitespace errors, no untracked plan/spec files, and only the files named by this plan.

- [ ] **Step 2: Run a non-mutating formatting check on every branch change**

```bash
git diff --name-only --diff-filter=ACMR origin/main...HEAD | xargs bunx oxfmt --check
```

Expected: PASS. This is the authoritative format check because the repository's current workspace `format:check` task is not wired to package scripts.

- [ ] **Step 3: Run the mandatory repository check and record the known lint baseline**

```bash
bun run check
```

Expected: the command executes the workspace checks. Feature-relevant typechecks, tests, formatting, builds, package namespace checks, docs build, and publint PASS; the command finally exits non-zero only for the pre-existing package anti-slop baseline. Compare its diagnostics with `/tmp/better-effect-lint-before.json` and confirm no new namespace, fixture, example, or documentation-related lint diagnostic.

- [ ] **Step 4: Re-run explicit package release checks**

```bash
cd packages/better-effect
bun run typecheck
bun run typecheck:example
bun test
bun run build
bun run check:public-type-namespaces
bun run publint
bun pm pack --dry-run
```

Expected:

- all explicit commands PASS;
- output reports TypeScript `5.2.2`;
- package namespace checker passes;
- publint passes;
- dry-run includes `dist/index.mjs`, `dist/index.d.mts`, declaration chunks, and maps;
- no source, test, or fixture files are included in the package.

- [ ] **Step 5: Re-run the root-graph checker and reject runtime assignments explicitly**

```bash
bun tests/package/public-type-namespaces/check.ts
rg_status=0
rg "(Effect\\.(Success|Error|Requirements|AnyResult)|Service\\.(Any|Token|Class|Instance|Tag|Requirements)|Layer\\.(Any|Specs|Provided|Required|Missing|Complete)|Runtime\\.(For|Options|ShutdownDiagnostic)|Scope\\.(Closeable|Outcome|Finalizer|Disposable))\\s*=" dist -g '*.mjs' || rg_status=$?

case "$rg_status" in
  0)
    echo "Unexpected runtime namespace assignment"
    exit 1
    ;;
  1) ;;
  *)
    echo "rg failed with status $rg_status"
    exit "$rg_status"
    ;;
esac
```

Expected: the checker confirms all five namespaces through the declaration graph rooted at `dist/index.d.mts`, and `rg` finds no runtime assignment.

- [ ] **Step 6: Review commits and final status**

```bash
cd ../..
git log --oneline --decorate origin/main..HEAD
git status --short
```

Expected: planning, source API, package compatibility, and documentation commits are present; working tree is clean.
