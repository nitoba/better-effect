# Official published documentation

Use the published `better-effect` documentation as the live reference for public APIs, semantics, examples, and integrations. This reference complements the local skill guidance; it does not override the version actually installed in the target project.

## Canonical endpoints

- Human-readable documentation: <https://better-effect.nitodev.com.br/docs>
- LLM page index: <https://better-effect.nitodev.com.br/llms.txt>
- Complete LLM corpus: <https://better-effect.nitodev.com.br/llms-full.txt>
- Per-page Markdown base: `https://better-effect.nitodev.com.br/llms.mdx`

## Lookup protocol

When web access is available and a task depends on current `better-effect` behavior or APIs:

1. Start with `https://better-effect.nitodev.com.br/llms.txt` to discover the relevant documentation page or the smallest useful set of pages.
2. Prefer page-specific Markdown over the rendered HTML or the complete corpus.
3. For a documentation route `/docs/<path>`, request:

   `https://better-effect.nitodev.com.br/llms.mdx/docs/<path>/content.md`

4. For the documentation root `/docs`, use the corresponding root content representation exposed by the index.
5. Follow links from that page only when another topic is needed to understand the contract or complete the implementation.
6. Use `https://better-effect.nitodev.com.br/llms-full.txt` as a fallback when:
   - the page index is unavailable;
   - a page-specific route cannot be resolved;
   - the task genuinely requires a cross-cutting view of most of the library.
7. Do not load the complete corpus by default when one or two focused pages are sufficient. Preserve context for the application code being edited.

The docs application also supports Markdown content negotiation for documentation routes. Prefer the explicit LLM Markdown endpoint above because it is predictable for agents and avoids rendered-page noise.

## Current documentation map

`llms.txt` is the authoritative discovery mechanism and should be preferred over this fixed list. At the time this skill was authored, the published guide set maps to these routes:

- introduction / complete path: `/docs`;
- installation and first application: `/docs/getting-started`;
- conceptual boundaries: `/docs/mental-model`;
- Service declaration, identity, structural implementations, and resolver bridge: `/docs/services`;
- Effect/Program generators, resources, combinators, and `Program.all`: `/docs/effects`;
- Layer provider recipes, composition, completeness, and override semantics: `/docs/layers`;
- Runtime ownership, warmup, observers, cancellation, `runWith`, typed boundaries, and shutdown: `/docs/runtime`;
- Hono request boundary integration: `/docs/hono`;
- hierarchical Scope ownership and cleanup order: `/docs/scope`;
- local acquire/use/release compatibility facade: `/docs/resource`;
- `pipe` and Result-aware Effect combinators: `/docs/pipelines`;
- typed errors, exception normalization, and cleanup precedence: `/docs/errors`;
- `MapLayerBackend`, ITI, and custom adapter responsibilities: `/docs/backends`;
- Runtime/Layer/type-contract testing: `/docs/testing`;
- executable Todo API architecture walkthrough: `/docs/todo-api`;
- practical recipes including configuration, request-local providers, and test doubles: `/docs/patterns`;
- common type/lifecycle failures and debugging checklist: `/docs/troubleshooting`.

Examples of page-specific Markdown URLs:

- `/docs/effects` → <https://better-effect.nitodev.com.br/llms.mdx/docs/effects/content.md>
- `/docs/runtime` → <https://better-effect.nitodev.com.br/llms.mdx/docs/runtime/content.md>
- `/docs/hono` → <https://better-effect.nitodev.com.br/llms.mdx/docs/hono/content.md>

If `llms.txt` exposes a newer, renamed, or more specific route, follow the published index instead of this list.

## Version precedence

When deciding whether an API can be used in a target project, use this order:

1. the target project's `package.json`, lockfile, and actually installed `better-effect` package;
2. source/declaration/tests for that installed version when locally available;
3. official published documentation for current semantics, examples, and API discovery;
4. local skill references as architecture/refactoring heuristics.

The published site tracks the current project and may be ahead of an application pinned to an older version. If the docs show an API that does not exist in the installed package, do not introduce it silently. Adapt the implementation to the installed version or make the upgrade an explicit part of the change.

If a summary in `SKILL.md` conflicts with the current documentation, verify the package version. For the current package, prefer official docs plus source/tests. For an older package, prefer that version's source/declarations/tests.

## What to consult for common tasks

### New application or feature

Read, in order when necessary:

1. `getting-started`;
2. `mental-model`;
3. `services`;
4. `effects`;
5. `layers`;
6. `runtime`;
7. `scope` when resources are involved.

Do not mechanically read every page if the task is already narrow.

### Existing Result code moving to better-effect

Prioritize:

- `effects`;
- `pipelines`;
- `errors`;
- `services`;
- `layers`.

The intended migration keeps `better-result` as the failure/control-flow model and adds typed environmental requirements and lifecycle ownership only where useful.

### HTTP/Hono integration

Prioritize:

- `hono`;
- `runtime`;
- `scope`;
- `errors`;
- `patterns` for request-local providers.

### Resource and shutdown bugs

Prioritize:

- `runtime`;
- `scope`;
- `resource`;
- `effects` for `Effect.acquireRelease` / `Effect.add`;
- `troubleshooting`.

### DI/container integration

Prioritize:

- `backends`;
- `services`;
- `layers`;
- `runtime`.

Keep container identifiers and provider mechanics out of application Services.

### Testing

Prioritize:

- `testing`;
- `layers` for explicit overrides;
- `services` for `Service.of`;
- `runtime` / `scope` for lifetime tests;
- `patterns` for deterministic standard services.

## Source inspection fallback

When documentation is insufficient, inspect the public implementation and tests in the repository. High-value paths include:

```text
packages/better-effect/src/index.ts
packages/better-effect/src/effect/
packages/better-effect/src/service/
packages/better-effect/src/layer/
packages/better-effect/src/runtime/
packages/better-effect/src/scope/
packages/better-effect/src/resource/
packages/better-effect/src/standard-services/
packages/better-effect/src/hono/
packages/better-effect/src/adapters/
packages/better-effect/tests/
packages/better-effect/examples/todo-api/
```

Public exports from the package root and declared subpath exports are the contract. Do not base application code on internal helpers merely because they exist in the repository.

## Documentation usage rule

Do not use the documentation only to copy snippets. Read the contract behind the example, then adapt it to the target application's actual failure model, Service graph, Runtime boundary, Scope ownership, framework lifecycle, and installed version.
