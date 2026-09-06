# Issue #148: phased Runtime shutdown and NodeRuntime.launch

## Goal

Implement the lifecycle contract from [issue #148](https://github.com/nitoba/better-effect/issues/148): phase Runtime shutdown, quiesce hooks for scoped Layer resources, graceful admission/draining, and a Layer-first `NodeRuntime.launch` entrypoint.

## Implementation slices

1. Extend scoped Layer lifecycle callbacks with optional quiesce metadata while preserving the release callback form.
2. Add Runtime admission gating, quiesce/drain/abort/release phases, shutdown reasons, and phase inspection events.
3. Add `NodeRuntime.launch` and explicit shutdown policy forwarding for `runMain`, including caller/process signals.
4. Add focused runtime/type coverage, update documentation, run verification, and open a PR against `main`.

## Constraints

- Keep DI adapters and `better-result` semantics unchanged.
- Keep quiesce separate from release; run all quiesce hooks and release even after hook failures.
- Preserve the primary program failure and never call `process.exit()`.
- Use this isolated worktree and do not merge the resulting PR.
