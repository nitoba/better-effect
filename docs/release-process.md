# Release process

Merging a pull request into `main` runs CI only. Releases are selected by an
allowlisted package tag:

| Package                     | Package directory                    | Tag                                    | Release notes          |
| --------------------------- | ------------------------------------ | -------------------------------------- | ---------------------- |
| `better-effect`             | `packages/better-effect`             | `v<version>`                           | root `CHANGELOG.md`    |
| `better-effect-better-auth` | `packages/better-effect-better-auth` | `better-effect-better-auth-v<version>` | package `CHANGELOG.md` |
| `better-effect-mq`          | `packages/better-effect-mq`          | `better-effect-mq-v<version>`          | package `CHANGELOG.md` |
| `better-effect-kysely`      | `packages/better-effect-kysely`      | `better-effect-kysely-v<version>`      | package `CHANGELOG.md` |

The route table is centralized in `scripts/release-packages.json`; both the
local release script and GitHub Actions resolve tags through
`scripts/release-route.ts`. The existing `v0.1.0` tag is a core `better-effect`
tag. It is not a valid alias for another package and must never be moved,
deleted, or reused.

```text
Pull request merge
        ↓
CI on main
        ↓
Inspect direct changes and workspace dependents
        ↓
Select each affected package and its local release notes
        ↓
Update the selected version, dependent development pins, and bun.lock
        ↓
Push its qualified tag
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

The release artifact gate is deliberately auth-free. It runs both
`bun pm pack --ignore-scripts` and `npm pack --ignore-scripts`, then inspects
the selected archives, manifests, declarations, source maps, and file
allowlist. Checking both packers keeps the gate aligned with the npm command
used for publication. It does not call `bun publish --dry-run`, because that
command can require registry credentials under the supported Bun version.

For the initial `better-effect-kysely@0.1.0` decision, the package check also
packs both `better-effect` and `better-effect-kysely`, installs them in a
throwaway external consumer, runs Bun SQLite and `better-sqlite3` plus PGlite
smoke programs under Bun and Node.js 24, typechecks with TypeScript 5.7.2 and the current compiler,
and checks an import-only consumer with no database driver. The documentation
page and generated LLM routes are checked by `bun run test:kysely-docs` and
`bun run docs:build`.

Use the non-mutating evidence sequence from a clean maintainer checkout:

```bash
bun install --frozen-lockfile
bun run check
bun run docs:build
(cd packages/better-effect-kysely && bun run check)
(cd packages/better-effect-kysely && bun run release:dry)
```

These commands prepare evidence only. They do not publish to npm or create a
Git tag; both remain a separate maintainer release decision.

## Bootstrapping a new npm package

npm Trusted Publishers can only be configured after the package name exists on
npm. Before creating the first qualified tag for `better-effect-better-auth`,
`better-effect-mq`, or `better-effect-kysely`, perform this one-time maintainer bootstrap:

1. Merge the package preparation change and check out the resulting `main`
   commit with a clean tree.
2. Run the package dry gate, which builds the package and validates both packers:

   ```bash
   ./scripts/release.sh better-effect-better-auth 0.1.0 --dry-run
   # or:
   ./scripts/release.sh better-effect-mq 0.1.0 --dry-run
   # or:
   ./scripts/release.sh better-effect-kysely 0.1.0 --dry-run
   ```

3. Authenticate locally with `npm login` (or another short-lived maintainer
   credential). Never add an npm token to the repository or GitHub secrets.
4. Publish the npm archive produced from the same checked-out commit that
   passed the dry gate:

   ```bash
   package_name=better-effect-better-auth
   package_dir=packages/better-effect-better-auth
   temp_dir="$(mktemp -d)"
   trap 'rm -rf "$temp_dir"' EXIT
   (cd "$package_dir" && npm pack --ignore-scripts --pack-destination "$temp_dir")
   archive="$(find "$temp_dir" -maxdepth 1 -type f -name "$package_name-0.1.0.tgz" -print -quit)"
   test -n "$archive"
   npm publish "$archive" --access public --registry=https://registry.npmjs.org --ignore-scripts
   ```

   Use the same commands with `package_name=better-effect-mq` and
   `package_dir=packages/better-effect-mq` for MQ, or with
   `package_name=better-effect-kysely` and
   `package_dir=packages/better-effect-kysely` for Kysely.

5. Configure npm Trusted Publishing for that package using the workflow details
   in [Release administration](#release-administration).
6. Run the normal package release command below. The workflow verifies that
   the already-published tarball exactly matches the selected tag before it
   creates the GitHub Release.

This exception is only for the first version of a new npm package. All later
versions are published by GitHub Actions with Trusted Publishing/OIDC.

## Publishing a release

1. Start from `main` with a clean maintainer checkout, or with only the
   selected package's intended changelog edit present. Ensure the selected
   package-local/root changelog contains a matching heading such as
   `## [0.1.0] - YYYY-MM-DD`.
2. For a hybrid release, inspect the reverse workspace dependency closure
   before choosing the tags. For example:

   ```bash
   bun run release:plan -- --base v0.13.0
   ```

   The planner reports packages changed in the range and their workspace
   dependents. Release a dependent as well when the core/API change affects its
   public contract; otherwise keep the release limited to the directly changed
   package.

3. Run the explicit package route:

   ```bash
   ./scripts/release.sh better-effect 0.14.0
   # Publish the initial independent Better Auth package:
   ./scripts/release.sh better-effect-better-auth 0.1.0
   # Publish the initial independent MQ package:
   ./scripts/release.sh better-effect-mq 0.1.0
   # Publish the initial independent Kysely package:
   ./scripts/release.sh better-effect-kysely 0.1.0
   # Validate a route and archive without changing, tagging, or publishing:
   ./scripts/release.sh better-effect-better-auth 0.1.0 --dry-run
   ```

   A bare version remains a compatibility spelling for the core package only.
   The script rejects packages outside the allowlist, mismatched manifest
   names, reused local/remote tags, missing local release notes, non-`main`
   checkouts, and unexpected changes outside the selected package, `bun.lock`,
   and its changelog. A core release may also synchronize the
   `better-effect` development pin in configured dependent package manifests;
   those metadata-only changes are included in the core release commit. The
   initial `better-effect-better-auth@0.1.0`, `better-effect-mq@0.1.0`, and
   `better-effect-kysely@0.1.0` routes tag their already selected manifest versions;
   later releases require an increasing version and create a version commit.
   Run the command once for each package that the release planner identifies;
   each command creates a package-qualified tag, so GitHub Actions publishes
   the packages independently without publishing unrelated packages.

4. Review the local commit and tag before the final atomic push. Never run the
   mutating script from an agent worktree:

   ```bash
   git push --atomic origin main v0.14.0
   git push --atomic origin main better-effect-better-auth-v0.1.0
   ```

   The release script normally performs this final push itself after all
   checks. The commands above document the exact package-qualified shape and
   are not a substitute for reviewing the tag.

The package release workflow accepts only `v<version>` for the core,
`better-effect-better-auth-v<version>` for the integration,
`better-effect-mq-v<version>` for the MQ package, or
`better-effect-kysely-v<version>` for the Kysely package. It checks out the exact tag,
verifies the corresponding manifest name/version and package-local release
notes, runs the quality gates and selected archive validation, and publishes
from the selected package directory. It never publishes an unrelated package
for a package-qualified tag.

Except for the one-time local bootstrap described above, real publication is
performed only by the reusable GitHub Actions workflow with npm Trusted
Publishing/OIDC (`id-token: write`). Local dry validation and review never
perform a real publish.

## Manual recovery

If the atomic push fails, keep the local release commit and tag, resolve the
remote problem, and retry the same atomic push. Do not rerun versioning or
move/delete an already-published tag.

Dispatch `release-please.yml` manually with the existing qualified tag to retry
the complete flow. The publish job reruns its quality gates and treats an
already published selected-package version as successful; GitHub Release
creation also checks for an existing release before creating one.

## Release administration

- Protect `v*`, `better-effect-better-auth-v*`, and `better-effect-mq-v*`,
  `better-effect-kysely-v*` tags from force-push and deletion.
- The workflow file keeps the `release-please.yml` name for npm Trusted
  Publishing compatibility; it does not run Release Please.
- Configure npm Trusted Publishing for each published package with workflow
  filename `release-please.yml`, repository `nitoba/better-effect`, and
  environment `npm`.
- Keep `id-token: write` in both the caller and reusable publish workflows.
- Do not enable a second release tool for these packages.

## References

- [GitHub Actions tag triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/)
