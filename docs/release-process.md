# Release process

This repository separates integration from publication:

```text
Pull request merge
        ↓
CI only on main
        ↓
Release Please opens or updates a Release PR
        ↓  (maintainer approval)
Release PR merge
        ↓
version + bun.lock + CHANGELOG update
        ↓
tag vX.Y.Z + GitHub Release
        ↓
publish workflow checks out that tag and publishes npm
```

## Normal development

Every pull request and every push to `main` runs CI. A normal merge does not
publish a package.

Use Conventional Commits so Release Please can calculate the next version:

- `fix:` → patch
- `feat:` → minor
- `feat!:` or a `BREAKING CHANGE` footer → major
- `chore:`, docs and formatting changes do not create a release by themselves

Release Please keeps one release pull request up to date. Review its version,
changelog and file changes before merging it.

## Publishing

After the Release PR is merged, Release Please creates the version tag and the
GitHub Release. The `release-please.yml` workflow then invokes the reusable
`publish.yml` workflow with the generated tag. Publishing checks out that exact
tag, runs the complete package validation, and publishes `better-effect` to npm
using Trusted Publishing/OIDC.

The release workflow synchronizes the package workspace version in Bun's
generated `bun.lock` on the Release Please branch and commits that one-line
update before the release PR is merged. This keeps the lockfile free of
updater-specific markers.

## Explicit version overrides

When Conventional Commits are not enough, use a `Release-As: X.Y.Z` footer in a
commit included in the next Release PR. Keep the `v` prefix only on Git tags;
the package version remains `X.Y.Z`.

## Manual recovery

If a publish needs to be retried, run the `Publish` workflow manually and enter
the existing tag, for example `v0.7.0`. Never move or delete an already-published
version tag. The workflow validates the tag before publishing.

## Release administration

- Protect `v*` tags from force-push and deletion.
- Keep the `autorelease: pending` and `autorelease: tagged` labels available;
  Release Please uses them to track the release PR lifecycle.
- Configure npm Trusted Publishing with workflow filename
  `release-please.yml` (the caller of the reusable publish job), repository
  `nitoba/better-effect` and environment `npm`.
- Keep `id-token: write` in both the caller and reusable publish workflows.
- Do not run semantic-release alongside Release Please; only one tool should
  own version calculation, tags and GitHub Releases.

## Referências

- [Release Please Action](https://github.com/googleapis/release-please-action)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
