# Release process

Merging a pull request into `main` runs CI only. A normal release starts when
a maintainer pushes a version tag:

```text
Pull request merge
        ↓
CI on main
        ↓
Update package version and bun.lock
        ↓
Push tag vX.Y.Z
        ↓
Validate tag and package version
        ↓
Publish better-effect to npm with Trusted Publishing/OIDC
        ↓
GitHub Release with generated notes
```

## Normal development

Pull requests and pushes to `main` never publish a package. Do not edit
`bun.lock` by hand; the release script refreshes it with `bun install` after the
package version is selected.

## Publishing a release

1. Start from `main` with a clean tree, or with only the intended
   `CHANGELOG.md` edit present. Add a dated heading such as
   `## [0.9.32] - 2026-08-28`.
2. Run the release script with either a bare version or its tag:

   ```bash
   ./scripts/release.sh 0.9.32
   # or: ./scripts/release.sh v0.9.32
   ```

   The script validates strict SemVer, checks the changelog entry, updates the
   package version, runs `bun install` and the non-mutating `bun run check`,
   verifies that only release files changed, and creates the release commit and
   annotated tag locally.

3. The final push is one atomic update of `main` and `v<version>` (for example,
   `git push --atomic origin main v0.9.32`). Review the local commit and tag
   before running the script from the maintainer's local `main` checkout. Never
   run it from an agent worktree.

The release script requires a matching changelog heading before creating a
release commit. The `Release` workflow accepts a valid `v<package-version>` tag
and invokes the reusable `publish.yml` workflow first. That workflow checks out
the exact tag, runs the quality gates and packed-consumer smoke test, and
publishes `better-effect` to npm. Only after that succeeds does the workflow
create the GitHub Release with generated notes.

## Manual recovery

If the atomic push fails, keep the local release commit and tag, resolve the
remote problem, and retry the same atomic push. Do not rerun the versioning
step or move/delete an already-published tag.

Dispatch `release-please.yml` manually and enter the existing tag to retry the
complete flow. The publish job reruns its quality gates and treats an already
published version as successful; GitHub Release creation also checks for an
existing release before creating one. `publish.yml` is reusable only and is
invoked by `release-please.yml`; it has no direct manual dispatch.

## Release administration

- Protect `v*` tags from force-push and deletion.
- The workflow file keeps the `release-please.yml` name for npm Trusted
  Publishing compatibility; it no longer runs Release Please.
- Configure npm Trusted Publishing with workflow filename
  `release-please.yml`, repository `nitoba/better-effect`, and environment
  `npm`.
- Keep `id-token: write` in both the caller and reusable publish workflows.
- Do not enable a second release tool for the same package; this workflow owns
  version tags, GitHub Releases, and npm publication.

## References

- [GitHub Actions tag triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
