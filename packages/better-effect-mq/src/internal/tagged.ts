/** Read a declaration-only tag without relying on a package-local class identity. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- guards accept arbitrary cross-package values.
export const hasTaggedError = <Tag extends string>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- guards accept arbitrary cross-package values.
  value: unknown,
  tag: Tag
): value is { readonly _tag: Tag } => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- tagged error guards accept unknown boundary values.
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return false
  }

  try {
    // SAFETY: the preceding guard permits only objects and functions here.
    let current = value as object | null
    const visited = new Set<object>()

    while (current !== null) {
      if (visited.has(current)) {
        return false
      }

      visited.add(current)
      const descriptor = Object.getOwnPropertyDescriptor(current, '_tag')

      if (descriptor !== undefined) {
        return 'value' in descriptor && descriptor.value === tag
      }

      current = Object.getPrototypeOf(current)
    }
  } catch {
    return false
  }

  return false
}
