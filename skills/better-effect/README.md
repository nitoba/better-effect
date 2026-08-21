# better-effect Agent Skill

Official skill for the [`nitoba/better-effect`](https://github.com/nitoba/better-effect) TypeScript library. It teaches coding agents how to implement, review, debug, and refactor applications using `better-effect` together with `better-result`.

## Install

With the Vercel Labs Agent Skills CLI:

```bash
npx skills add nitoba/better-effect --skill better-effect
```

Install globally for a specific agent:

```bash
npx skills add nitoba/better-effect --skill better-effect -g -a codex
```

Or use it without a permanent installation:

```bash
npx skills use nitoba/better-effect@better-effect
```

## What it covers

- typed failures with `better-result`;
- `Effect.gen`, lazy `Effect.fn` Programs, combinators, and `Program.all`;
- contextual dependencies with `Service` and `yield*`;
- `Service.of` structural implementations and stable Service identity;
- `Layer.make`, `succeed`, `scoped`, `gen`, `scopedGen`, `merge`, `override`, and completeness;
- typed Runtime environments, `Runtime.For`, warmup, `runWith`, cancellation, observers, and graceful shutdown;
- hierarchical Scope ownership, `Effect.acquireRelease`, `Effect.add`, and `Resource`;
- standard services such as Config, Clock, Random, Logger, CurrentRequest, and CurrentAbortSignal;
- Hono request-boundary integration with `HonoEffect`;
- `MapLayerBackend`, ITI, and custom DI adapters;
- testing with explicit test Layers and compile-time type contracts;
- architecture and refactoring guidance for existing TypeScript applications;
- anti-pattern detection and before/after transformation recipes.

## Official documentation

The skill treats the published documentation as a live reference:

- <https://better-effect.nitodev.com.br/docs> — human-readable docs;
- <https://better-effect.nitodev.com.br/llms.txt> — page index for agents/LLMs;
- `https://better-effect.nitodev.com.br/llms.mdx/docs/<path>/content.md` — focused Markdown for a documentation page;
- <https://better-effect.nitodev.com.br/llms-full.txt> — complete corpus used as a fallback.

The installed package version always wins for compatibility. The published documentation may describe a newer release than the application being edited.

## Files

- `SKILL.md` contains the main workflow, mental model, API guidance, ownership rules, testing rules, and completion criteria.
- `references/refactoring-rules.md` contains the full inventory and decision rules for existing codebases.
- `references/transformation-patterns.md` contains practical before/after refactoring recipes.
- `references/official-documentation.md` defines the live documentation lookup protocol and route map.

The skill deliberately does **not** teach agents to reproduce Effect TS. `better-effect` keeps `better-result` as its error/control-flow model and adds a focused set of typed Service, Layer, Runtime, Scope, and integration primitives around it.
