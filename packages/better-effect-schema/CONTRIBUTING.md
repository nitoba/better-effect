# Contributing to better-effect-schema

## Requirements

- Node.js 20 or newer
- Bun
- Zod 4.5.4 or newer within Zod 4
- better-result 3.x
- better-effect 0.13.x
- TypeScript 6.0 or newer

## Setup

```bash
bun install --frozen-lockfile
bun run check --filter=better-effect-schema
```

## Development rules

- Add a failing runtime or type test before changing behavior.
- Keep Zod, better-result, and better-effect as peers; do not add Effect TS or `@effect/*`.
- Use only the public root entrypoints of better-effect and better-result.
- Keep schema operations requirement-free: schemas must not acquire Services.
- Keep expected validation failures in the typed Result channel and package-contract misuse as `BetterEffectZodError` defects.
- Do not override `_parse`, `_parseSync`, or `_parseAsync`.
- Do not instantiate Zod wrapper classes directly.
- Do not add TypeScript suppression directives to `src`.
- Keep encoded input, decoded constructor props, and class instance output distinct.
- Give new public APIs documentation plus positive and negative type tests.
- Validate packed artifacts outside the workspace before release.

## Commands

```bash
bun run typecheck
bun run test
bun run examples
bun run check:source
bun run check:package
bun run test:package
npm pack --dry-run --ignore-scripts
```

## Pull requests

Describe the behavioral contract, the red/green evidence, compatibility implications, and every public type change. Keep unrelated refactors out of feature changes.
