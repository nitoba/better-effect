#!/usr/bin/env bash

set -euo pipefail

PACKAGE_FILE="packages/better-effect/package.json"
LOCK_FILE="bun.lock"
CHANGELOG_FILE="CHANGELOG.md"
BRANCH="main"

# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

error() {
  echo "❌ $1" >&2
  exit 1
}

info() {
  echo "→ $1"
}

success() {
  echo "✓ $1"
}

# ─────────────────────────────────────────────────────────────
# Version
# ─────────────────────────────────────────────────────────────

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <version>"
  echo
  echo "Examples:"
  echo "  $0 0.9.32"
  echo "  $0 v0.9.32"
  exit 1
fi

# Accept both "0.9.32" and "v0.9.32".
VERSION="${1#v}"
TAG="v${VERSION}"

# ─────────────────────────────────────────────────────────────
# Preconditions
# ─────────────────────────────────────────────────────────────

command -v git >/dev/null || error "git is not installed"
command -v bun >/dev/null || error "bun is not installed"

[[ -f "$PACKAGE_FILE" ]] || error "$PACKAGE_FILE not found"
[[ -f "$LOCK_FILE" ]] || error "$LOCK_FILE not found"
[[ -f "$CHANGELOG_FILE" ]] || error "$CHANGELOG_FILE not found"

if ! VERSION_TO_VALIDATE="$VERSION" bun -e '
  const version = process.env.VERSION_TO_VALIDATE
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

  if (!semver.test(version)) {
    process.exit(1)
  }
'; then
  error "Invalid SemVer version: $VERSION"
fi

CURRENT_BRANCH="$(git branch --show-current)"

if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
  error "Release must be executed from '$BRANCH'. Current branch: '$CURRENT_BRANCH'"
fi

if [[ -n "$(git status --porcelain)" ]]; then
  while IFS= read -r status; do
    [[ "${status:3}" == "$CHANGELOG_FILE" ]] || error "Working tree has changes outside $CHANGELOG_FILE"
  done < <(git status --porcelain)
fi

if git show-ref --verify --quiet "refs/tags/$TAG"; then
  error "Tag '$TAG' already exists locally."
fi

remote_tag_status=0
git ls-remote --exit-code --refs origin "refs/tags/$TAG" >/dev/null 2>&1 || remote_tag_status=$?
case "$remote_tag_status" in
  0) error "Tag '$TAG' already exists on origin." ;;
  2) ;;
  *) error "Could not verify whether '$TAG' exists on origin." ;;
esac

CURRENT_VERSION="$(
  bun -e "
    const pkg = await Bun.file('$PACKAGE_FILE').json();
    process.stdout.write(pkg.version);
  "
)"

if ! CURRENT_VERSION="$CURRENT_VERSION" NEXT_VERSION="$VERSION" bun -e '
  const current = process.env.CURRENT_VERSION
  const next = process.env.NEXT_VERSION
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

  if (!semver.test(current) || Bun.semver.order(current, next) >= 0) {
    process.exit(1)
  }
'; then
  error "Next version ($VERSION) must be greater than current package version ($CURRENT_VERSION)"
fi

if ! grep -Fq "## [$VERSION]" "$CHANGELOG_FILE"; then
  error "$CHANGELOG_FILE must contain a ## [$VERSION] entry before releasing"
fi

echo
echo "Release"
echo "────────────────────────────────────────"
echo "Package:  better-effect"
echo "Current:  $CURRENT_VERSION"
echo "Next:     $VERSION"
echo "Tag:      $TAG"
echo "Branch:   $BRANCH"
echo "────────────────────────────────────────"
echo

# ─────────────────────────────────────────────────────────────
# Update package.json
# ─────────────────────────────────────────────────────────────

info "Updating $PACKAGE_FILE"

PACKAGE_FILE="$PACKAGE_FILE" VERSION="$VERSION" bun -e '
  const path = process.env.PACKAGE_FILE;
  const version = process.env.VERSION;

  const file = Bun.file(path);
  const pkg = await file.json();

  pkg.version = version;

  await Bun.write(
    path,
    JSON.stringify(pkg, null, 2) + "\n"
  );
'

success "$PACKAGE_FILE updated: $CURRENT_VERSION → $VERSION"

# ─────────────────────────────────────────────────────────────
# Update bun.lock
# ─────────────────────────────────────────────────────────────

info "Running bun install"

bun install

success "Dependencies and bun.lock updated"

# ─────────────────────────────────────────────────────────────
# Check
# ─────────────────────────────────────────────────────────────

info "Running checks"

bun run check

success "Checks passed"

# ─────────────────────────────────────────────────────────────
# Verify version
# ─────────────────────────────────────────────────────────────

UPDATED_VERSION="$(
  bun -e "
    const pkg = await Bun.file('$PACKAGE_FILE').json();
    process.stdout.write(pkg.version);
  "
)"

[[ "$UPDATED_VERSION" == "$VERSION" ]] \
  || error "Version verification failed. Expected $VERSION, got $UPDATED_VERSION"

# ─────────────────────────────────────────────────────────────
# Commit
# ─────────────────────────────────────────────────────────────

info "Creating release commit"

git diff HEAD --check

changed_files="$(git diff HEAD --name-only)"
while IFS= read -r changed_file; do
  [[ -z "$changed_file" ]] && continue
  case "$changed_file" in
    "$PACKAGE_FILE"|"$LOCK_FILE"|"$CHANGELOG_FILE") ;;
    *) error "Release checks modified unexpected file: $changed_file" ;;
  esac
done <<< "$changed_files"

git add "$PACKAGE_FILE" "$LOCK_FILE" "$CHANGELOG_FILE"

git commit -m "chore(release): $VERSION"

success "Release commit created"

# ─────────────────────────────────────────────────────────────
# Tag and atomic push
# ─────────────────────────────────────────────────────────────

info "Creating tag $TAG"

git tag -a "$TAG" -m "Release $TAG"

success "Tag created locally"

info "Atomically pushing $BRANCH and $TAG"

git push --atomic origin "$BRANCH" "$TAG"

success "Branch and tag pushed atomically"

echo
echo "🚀 Released better-effect $TAG"
