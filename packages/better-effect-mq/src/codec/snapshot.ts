// Internal marker for codec values produced by this package. Job definitions may
// retain their operation-level contract without treating the operations as
// user-owned receiver state.

// oxlint-disable anti-slop/no-runtime-typeof -- this marker crosses an internal JavaScript boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- marker checks are internal untyped boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- type assertions follow callable checks.

export const codecSnapshotTypeId = Symbol.for('better-effect-mq/CodecSnapshot')

type CodecOperation = (...arguments_: never[]) => void

const codecSnapshotOperations = new WeakSet<CodecOperation>()

export const markCodecSnapshot = <Value extends object>(value: Value): Value => {
  const encode = Object.getOwnPropertyDescriptor(value, 'encode')?.value
  const decode = Object.getOwnPropertyDescriptor(value, 'decode')?.value

  if (typeof encode === 'function') {
    // SAFETY: The typeof check establishes the WeakSet key's callable shape.
    codecSnapshotOperations.add(encode as CodecOperation)
    Object.freeze(encode)
  }

  if (typeof decode === 'function') {
    // SAFETY: The typeof check establishes the WeakSet key's callable shape.
    codecSnapshotOperations.add(decode as CodecOperation)
    Object.freeze(decode)
  }

  Object.defineProperty(value, codecSnapshotTypeId, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  })

  return Object.freeze(value)
}

export const isMarkedCodecSnapshot = (value: unknown): boolean => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- arbitrary values may cross the Job boundary.
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return false
  }

  try {
    return Object.getOwnPropertyDescriptor(value, codecSnapshotTypeId)?.value === true
  } catch {
    return false
  }
}

export const isMarkedCodecOperation = (value: unknown): boolean => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- arbitrary codec members are inspected at runtime.
  if (typeof value !== 'function') {
    return false
  }

  // SAFETY: The typeof check establishes the WeakSet key's callable shape.
  return codecSnapshotOperations.has(value as CodecOperation)
}
