#!/usr/bin/env bash

set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPOSITORY_ROOT"

BRANCH="main"
LOCK_FILE="bun.lock"
DRY_RUN=false

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

has_changelog_heading() {
  local changelog_file="$1"
  local version="$2"

  awk -v expected="## [$version]" '
    index($0, expected) == 1 &&
      (length($0) == length(expected) || substr($0, length(expected) + 1, 1) == " ") {
      found = 1
      exit
    }
    END { exit found ? 0 : 1 }
  ' "$changelog_file"
}

synchronize_development_dependencies() {
  local core_version="$1"
  local target_package="$2"
  local changed_files

  changed_files="$(CORE_VERSION="$core_version" TARGET_PACKAGE="$target_package" bun -e '
    const version = process.env.CORE_VERSION
    const target = process.env.TARGET_PACKAGE
    const config = await Bun.file("scripts/release-packages.json").json()

    for (const route of config.packages) {
      if (route.name === "better-effect" || (target !== "all" && route.name !== target)) continue
      const path = `${route.directory}/package.json`
      const pkg = await Bun.file(path).json()
      const dependencies = pkg.devDependencies
      if (!dependencies || typeof dependencies !== "object") continue
      if (dependencies["better-effect"] === undefined || dependencies["better-effect"] === version) continue
      dependencies["better-effect"] = version
      await Bun.write(path, `${JSON.stringify(pkg, null, 2)}\n`)
      console.log(path)
    }
  ')"

  while IFS= read -r changed_file; do
    [[ -z "$changed_file" ]] || SYNCED_PACKAGE_FILES+=("$changed_file")
  done <<< "$changed_files"
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/release.sh <version>                              # better-effect (legacy)
  ./scripts/release.sh <package> <version> [--dry-run]

Allowlisted packages and tags:
  better-effect             v<version>
  better-effect-better-auth better-effect-better-auth-v<version>
  better-effect-mq          better-effect-mq-v<version>
  better-effect-kysely      better-effect-kysely-v<version>
  better-effect-mq-postgres better-effect-mq-postgres-v<version>
  better-effect-mq-redis    better-effect-mq-redis-v<version>

The release must be run from a clean maintainer checkout on main. The dry-run
validates the selected route and packed artifact without changing or publishing
anything.
EOF
}

if [[ $# -eq 0 || "$1" == "--help" ]]; then
  usage
  exit 0
fi

positional=()
for argument in "$@"; do
  if [[ "$argument" == "--dry-run" ]]; then
    DRY_RUN=true
  else
    positional+=("$argument")
  fi
done

if [[ ${#positional[@]} -eq 1 ]]; then
  PACKAGE_NAME="better-effect"
  VERSION_INPUT="${positional[0]}"
elif [[ ${#positional[@]} -eq 2 ]]; then
  PACKAGE_NAME="${positional[0]}"
  VERSION_INPUT="${positional[1]}"
else
  usage >&2
  exit 1
fi

command -v git >/dev/null || error "git is not installed"
command -v bun >/dev/null || error "bun is not installed"

route_output="$(bun scripts/release-route.ts --package "$PACKAGE_NAME")" \
  || error "Package '$PACKAGE_NAME' is not allowlisted. Refusing to select a release target."
PACKAGE_DIR=""
CHANGELOG_FILE=""
TAG_PREFIX=""
INITIAL_RELEASE=""
SYNCED_PACKAGE_FILES=()
while IFS='=' read -r key value; do
  case "$key" in
    package_dir) PACKAGE_DIR="$value" ;;
    changelog) CHANGELOG_FILE="$value" ;;
    tag_prefix) TAG_PREFIX="$value" ;;
    initial_release) INITIAL_RELEASE="$value" ;;
  esac
done <<< "$route_output"

[[ -n "$PACKAGE_DIR" && -n "$CHANGELOG_FILE" && -n "$TAG_PREFIX" ]] \
  || error "Release route for '$PACKAGE_NAME' is incomplete"
PACKAGE_FILE="$PACKAGE_DIR/package.json"
VERSION="${VERSION_INPUT#v}"
TAG="${TAG_PREFIX}${VERSION}"

[[ -f "$PACKAGE_FILE" ]] || error "$PACKAGE_FILE not found"
[[ -f "$LOCK_FILE" ]] || error "$LOCK_FILE not found"
[[ -f "$CHANGELOG_FILE" ]] || error "$CHANGELOG_FILE not found"

if ! VERSION_TO_VALIDATE="$VERSION" bun -e '
  const version = process.env.VERSION_TO_VALIDATE
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

  if (!semver.test(version)) process.exit(1)
'; then
  error "Invalid SemVer version: $VERSION"
fi

CURRENT_BRANCH="$(git branch --show-current)"
[[ "$CURRENT_BRANCH" == "$BRANCH" ]] \
  || error "Release must be executed from '$BRANCH'. Current branch: '$CURRENT_BRANCH'"

if [[ -n "$(git status --porcelain)" ]]; then
  while IFS= read -r status; do
    [[ "${status:3}" == "$CHANGELOG_FILE" ]] \
      || error "Working tree has changes outside $CHANGELOG_FILE"
  done < <(git status --porcelain)
fi

read -r MANIFEST_NAME CURRENT_VERSION < <(
  PACKAGE_FILE="$PACKAGE_FILE" bun -e '
    const pkg = await Bun.file(process.env.PACKAGE_FILE).json()
    process.stdout.write(`${pkg.name} ${pkg.version}\n`)
  '
)
[[ "$MANIFEST_NAME" == "$PACKAGE_NAME" ]] \
  || error "Expected $PACKAGE_NAME in $PACKAGE_FILE, found $MANIFEST_NAME"

if git show-ref --verify --quiet "refs/tags/$TAG"; then
  error "Tag '$TAG' already exists locally. Package release tags are immutable and cannot be reused."
fi

remote_tag_status=0
git ls-remote --exit-code --refs origin "refs/tags/$TAG" >/dev/null 2>&1 || remote_tag_status=$?
case "$remote_tag_status" in
  0) error "Tag '$TAG' already exists on origin." ;;
  2) ;;
  *) error "Could not verify whether '$TAG' exists on origin." ;;
esac

if ! CURRENT_VERSION="$CURRENT_VERSION" NEXT_VERSION="$VERSION" INITIAL_RELEASE="$INITIAL_RELEASE" bun -e '
  const current = process.env.CURRENT_VERSION
  const next = process.env.NEXT_VERSION
  const initial = process.env.INITIAL_RELEASE === "true"
  const equalInitial = initial && current === next && next === "0.1.0"

  if (equalInitial) process.exit(0)

  if (Bun.semver.order(current, next) >= 0) process.exit(1)
'; then
  error "Next version ($VERSION) must be greater than current package version ($CURRENT_VERSION), except for an initial package 0.1.0 tag"
fi

has_changelog_heading "$CHANGELOG_FILE" "$VERSION" \
  || error "$CHANGELOG_FILE must contain a ## [$VERSION] entry before releasing"

cat <<EOF

Release
────────────────────────────────────────
Package:  $PACKAGE_NAME
Current:  $CURRENT_VERSION
Next:     $VERSION
Tag:      $TAG
Branch:   $BRANCH
Changelog: $CHANGELOG_FILE
────────────────────────────────────────

EOF

if [[ "$DRY_RUN" == true ]]; then
  info "Building and validating the selected packed artifact without publishing"
  (cd "$PACKAGE_DIR" && bun run build && bun run release:dry)
  success "Dry release validation passed"
  exit 0
fi

if [[ "$CURRENT_VERSION" != "$VERSION" ]]; then
  info "Updating $PACKAGE_FILE"
  PACKAGE_FILE="$PACKAGE_FILE" VERSION="$VERSION" bun -e '
    const path = process.env.PACKAGE_FILE
    const version = process.env.VERSION
    const file = Bun.file(path)
    const pkg = await file.json()
    pkg.version = version
    await Bun.write(path, `${JSON.stringify(pkg, null, 2)}\n`)
  '
  success "$PACKAGE_FILE updated: $CURRENT_VERSION → $VERSION"
else
  info "Keeping the already selected initial version $VERSION"
fi

if [[ "$PACKAGE_NAME" == "better-effect" ]]; then
  info "Synchronizing dependent development dependencies"
  synchronize_development_dependencies "$VERSION" all
else
  info "Synchronizing the better-effect development dependency"
  CORE_VERSION="$(PACKAGE_FILE="packages/better-effect/package.json" bun -e '
    const pkg = await Bun.file(process.env.PACKAGE_FILE).json()
    process.stdout.write(String(pkg.version))
  ')"
  synchronize_development_dependencies "$CORE_VERSION" "$PACKAGE_NAME"
fi

if [[ ${#SYNCED_PACKAGE_FILES[@]} -gt 0 ]]; then
  success "Synchronized: ${SYNCED_PACKAGE_FILES[*]}"
fi

info "Running bun install"
bun install
success "Dependencies and bun.lock updated"

info "Running checks"
bun run check
success "Checks passed"

read -r UPDATED_NAME UPDATED_VERSION < <(
  PACKAGE_FILE="$PACKAGE_FILE" bun -e '
    const pkg = await Bun.file(process.env.PACKAGE_FILE).json()
    process.stdout.write(`${pkg.name} ${pkg.version}\n`)
  '
)
[[ "$UPDATED_NAME" == "$PACKAGE_NAME" && "$UPDATED_VERSION" == "$VERSION" ]] \
  || error "Final manifest verification failed: $UPDATED_NAME@$UPDATED_VERSION"

info "Checking release diff"
git diff HEAD --check
changed_files="$(git diff HEAD --name-only)"
while IFS= read -r changed_file; do
  [[ -z "$changed_file" ]] && continue
  case "$changed_file" in
    "$PACKAGE_FILE"|"$LOCK_FILE"|"$CHANGELOG_FILE") ;;
    *)
      synced=false
      for synced_file in "${SYNCED_PACKAGE_FILES[@]}"; do
        [[ "$changed_file" == "$synced_file" ]] && synced=true && break
      done
      [[ "$synced" == true ]] || error "Release checks modified unexpected file: $changed_file"
      ;;
  esac
done <<< "$changed_files"

git add "$PACKAGE_FILE" "$LOCK_FILE" "$CHANGELOG_FILE" "${SYNCED_PACKAGE_FILES[@]}"
if git diff --cached --quiet; then
  info "No version files changed; tagging the prepared initial release commit"
else
  info "Creating release commit"
  git commit -m "chore(release): $PACKAGE_NAME@$VERSION"
  success "Release commit created"
fi

info "Creating tag $TAG"
git tag -a "$TAG" -m "Release $PACKAGE_NAME@$VERSION"
success "Tag created locally"

info "Atomically pushing $BRANCH and $TAG"
git push --atomic origin "$BRANCH" "$TAG"
success "Branch and tag pushed atomically"

echo
echo "🚀 Released $PACKAGE_NAME@$VERSION as $TAG"
