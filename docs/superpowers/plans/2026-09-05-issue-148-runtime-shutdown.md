# Issue #148: phased Runtime shutdown and NodeRuntime.launch

## Goal

Implement the lifecycle contract from [issue #148](https://github.com/nitoba/better-effect/issues/148): phase Runtime shutdown, quiesce hooks for scoped Layer resources, graceful admission/draining, and a Layer-first `NodeRuntime.launch` entrypoint.

## Constraints

- Keep the core container-agnostic and preserve the existing `better-result` semantics.
- Keep work isolated in this worktree and open a PR against `main`; do not merge it here.
- Preserve the existing simple release callback overloads while adding the lifecycle callback form.
- Keep shutdown failures best-effort and preserve the primary program failure.
- Verify runtime behavior, type contracts, examples/docs, and the repository check gate.

## Implementation slices

1. Extend internal Layer lifecycle/provider entries and public `scopedGen`/`scopedDiscard` APIs with optional quiesce callbacks.
2. Refactor Runtime disposal into admission, quiesce, drain, optional abort, release, and backend-disposal phases; retain reason metadata and observable phase state.
3. Add `NodeRuntime.launch` and nested shutdown policy handling to `runMain`, including signals and caller abort without `process.exit` or polling.
4. Add focused runtime and type tests, update README/example usage where the public lifecycle API is described, and run the repository verification commands.

## Completion

Commit the implementation on the issue worktree, push the branch, and create one PR targeting `main` with `Closes #148`.
