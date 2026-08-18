#!/usr/bin/env bash

set -euo pipefail

PACKAGE_FILE="packages/better-effect/package.json"
LOCK_FILE="bun.lock"
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
  echo "  $0 0.8.0"
  echo "  $0 v0.8.0"
  exit 1
fi

# Accept both "0.8.0" and "v0.8.0"
VERSION="${1#v}"
TAG="v${VERSION}"

# Basic SemVer validation, including prereleases.
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  error "Invalid version: $VERSION"
fi

# ─────────────────────────────────────────────────────────────
# Preconditions
# ─────────────────────────────────────────────────────────────

command -v git >/dev/null || error "git is not installed"
command -v bun >/dev/null || error "bun is not installed"

[[ -f "$PACKAGE_FILE" ]] || error "$PACKAGE_FILE not found"
[[ -f "$LOCK_FILE" ]] || error "$LOCK_FILE not found"

CURRENT_BRANCH="$(git branch --show-current)"

if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
  error "Release must be executed from '$BRANCH'. Current branch: '$CURRENT_BRANCH'"
fi

if [[ -n "$(git status --porcelain)" ]]; then
  error "Working tree is not clean. Commit or stash your changes first."
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  error "Tag '$TAG' already exists."
fi

CURRENT_VERSION="$(
  bun -e "
    const pkg = await Bun.file('$PACKAGE_FILE').json();
    process.stdout.write(pkg.version);
  "
)"

if [[ "$CURRENT_VERSION" == "$VERSION" ]]; then
  error "Package is already at version $VERSION"
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

git add "$PACKAGE_FILE" "$LOCK_FILE"

git commit -m "chore(release): $VERSION"

success "Release commit created"

# ─────────────────────────────────────────────────────────────
# Push
# ─────────────────────────────────────────────────────────────

info "Pushing $BRANCH"

git push origin "$BRANCH"

success "Branch pushed"

# ─────────────────────────────────────────────────────────────
# Tag
# ─────────────────────────────────────────────────────────────

info "Creating tag $TAG"

git tag -a "$TAG" -m "Release $TAG"

success "Tag created"

info "Pushing tag $TAG"

git push origin "$TAG"

success "Tag pushed"

echo
echo "🚀 Released better-effect $TAG"
