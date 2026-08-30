# Release process

Merging a pull request into `main` runs CI only. Releases are selected by an
allowlisted package tag:

| Package | Package directory | Tag | Release notes |
| --- | --- | --- | --- |
| `better-effect` | `packages/better-effect` | `v<version>` | root `CHANGELOG.md` |
| `better-effect-better-auth` | `packages/better-effect-better-auth` | `better-effect-better-auth-v<version>` | package `CHANGELOG.md` |

The existing `v0.1.0` tag is a core `better-effect` tag. It is not a valid
alias for the Better Auth package and must never be moved, deleted, or reused.

```text
Pull request merge
        ↓
CI on main
        ↓
Select one allowlisted package and its local release notes
        ↓
Update that package version and bun.lock when needed
        ↓
Push the qualified tag
        ↓
Validate exact tag, package name/version, notes, and packed artifact
        ↓
Publish only the selected package with Trusted Publishing/OIDC
        ↓
Create the package-specific GitHub Release
```

## Normal development

Pull requests and pushes to `main` never publish a package. Do not edit
`bun.lock` by hand; the release script refreshes it with `bun install` after
the package version is selected.

The release artifact gate is deliberately auth-free. It runs
`bun pm pack --ignore-scripts` and inspects the selected archive, manifest,
declarations, source maps, and file allowlist. It does not call
`bun publish --dry-run`, because that command can require registry
credentials under the supported Bun version.

## Publishing a release

1. Start from `main` with a clean maintainer checkout, or with only the
   selected package's intended changelog edit present. Ensure the selected
   package-local/root changelog contains a matching heading such as
   `## [0.1.0] - YYYY-MM-DD`.
2. Run the explicit package route:

   ```bash
   ./scripts/release.sh better-effect 0.14.0
   # Publish the initial independent Better Auth package:
   ./scripts/release.sh better-effect-better-auth 0.1.0
   # Validate a route and archive without changing, tagging, or publishing:
   ./scripts/release.sh better-effect-better-auth 0.1.0 --dry-run
   ```

   A bare version remains a compatibility spelling for the core package only.
   The script rejects packages outside the allowlist, mismatched manifest
   names, reused local/remote tags, missing local release notes, non-`main`
   checkouts, and changes outside the selected package, `bun.lock`, and its
   changelog. The initial `better-effect-better-auth@0.1.0` route tags the
   already selected manifest version; later releases require an increasing
   version and create a version commit.
3. Review the local commit and tag before the final atomic push. Never run the
   mutating script from an agent worktree:

   ```bash
   git push --atomic origin main v0.14.0
   git push --atomic origin main better-effect-better-auth-v0.1.0
   ```

   The release script normally performs this final push itself after all
   checks. The commands above document the exact package-qualified shape and
   are not a substitute for reviewing the tag.

The package release workflow accepts only `v<version>` for the core or
`better-effect-better-auth-v<version>` for the integration. It checks out the
exact tag, verifies the corresponding manifest name/version and package-local
release notes, runs the quality gates and selected archive validation, and
publishes from the selected package directory. It never publishes the core for
an integration tag or the integration for a core tag.

Real publication is performed only by the reusable GitHub Actions workflow
with npm Trusted Publishing/OIDC (`id-token: write`). Local dry validation and
review never perform a real publish.

## Manual recovery

If the atomic push fails, keep the local release commit and tag, resolve the
remote problem, and retry the same atomic push. Do not rerun versioning or
move/delete an already-published tag.

Dispatch `release-please.yml` manually with the existing qualified tag to retry
the complete flow. The publish job reruns its quality gates and treats an
already published selected-package version as successful; GitHub Release
creation also checks for an existing release before creating one.

## Release administration

- Protect `v*` and `better-effect-better-auth-v*` tags from force-push and
  deletion.
- The workflow file keeps the `release-please.yml` name for npm Trusted
  Publishing compatibility; it does not run Release Please.
- Configure npm Trusted Publishing with workflow filename
  `release-please.yml`, repository `nitoba/better-effect`, and environment
  `npm`.
- Keep `id-token: write` in both the caller and reusable publish workflows.
- Do not enable a second release tool for either package.

## References

- [GitHub Actions tag triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/)
