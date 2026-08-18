# Release process

Merging a pull request into `main` runs CI only. A release starts only when a
maintainer pushes a version tag:

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
GitHub Release with generated notes
        ↓
Publish better-effect to npm with Trusted Publishing/OIDC
```

## Normal development

Pull requests and pushes to `main` never publish a package. Keep the package
version in `packages/better-effect/package.json` synchronized with the matching
workspace entry in `bun.lock`.

## Publishing a release

1. Update `packages/better-effect/package.json` to the intended version.
2. Run `bun install` to refresh `bun.lock`, then run `bun run check`.
3. Commit the version and lockfile changes on `main`.
4. Create and push the matching tag:

   ```bash
   git tag -a v0.9.0 -m "Release v0.9.0"
   git push origin v0.9.0
   ```

The `Release` workflow accepts only tags in the `v<package-version>` format.
It creates the GitHub Release and invokes the reusable `publish.yml` workflow,
which checks out the exact tag, runs package validation, and publishes
`better-effect` to npm.

## Manual recovery

Run the `Release` workflow manually and enter the existing tag to retry the
complete flow. The GitHub Release creation is idempotent. The reusable
`Publish` workflow can also be run directly when only npm publication needs to
be retried.

Never move or delete an already-published version tag.

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

## Referências

- [GitHub Actions tag triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
