# Contributing to better-effect-schema

## Requirements

- Bun and the current TypeScript compiler
- `better-result` 3.x
- `better-effect` 0.14.x
- optional provider peers only when an adapter is being changed

## Development rules

- Add a `bun:test` runtime test or a `tests/types` contract before changing
  behavior.
- Keep the root package provider-neutral and use adapter subpaths for native
  provider code.
- Keep expected validation failures in typed Result channels.
- Keep schema operations requirement-free and delegate Result semantics to
  `better-result`.
- Do not add parser shims, throwing convenience APIs, or provider imports to
  core modules.
- Do not add TypeScript suppression directives to `src`.
- Update examples and documentation for every public API change.

## Commands

```bash
bun run typecheck
bun run test:runtime
bun run test:types
bun run examples
bun run check:source
bun run check:package
bun run test:package
bun run publint
bun run check
```

Pull requests should describe the behavioral contract, runtime/type evidence,
adapter implications, and public type changes. Keep unrelated package or
worktree changes out of the branch.
