// Internal capability for codec values produced by this package. Job definitions may
// retain their operation-level contract without treating the operations as
// user-owned receiver state. The capability is deliberately not represented by a
// property: a duplicated package copy must take the structural snapshot path.

// oxlint-disable anti-slop/no-runtime-typeof -- this capability crosses an internal JavaScript boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- capability checks are internal untyped boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- type assertions follow callable checks.

type CodecOperation = (...arguments_: never[]) => void

type CodecSnapshot = {
  readonly encode: CodecOperation
  readonly decode: CodecOperation
}

const codecSnapshots = new WeakMap<object, CodecSnapshot>()
const codecSnapshotOperations = new WeakSet<CodecOperation>()

export const markCodecSnapshot = <Value extends object>(value: Value): Value => {
  const encode = Object.getOwnPropertyDescriptor(value, 'encode')?.value
  const decode = Object.getOwnPropertyDescriptor(value, 'decode')?.value

  if (typeof encode !== 'function' || typeof decode !== 'function') {
    throw new TypeError('Codec snapshots require callable encode and decode operations')
  }

  // SAFETY: The typeof checks establish the callable shape at the package constructor boundary.
  const snapshot = Object.freeze({
    encode: encode as CodecOperation,
    decode: decode as CodecOperation
  })

  codecSnapshots.set(value, snapshot)
  codecSnapshotOperations.add(snapshot.encode)
  codecSnapshotOperations.add(snapshot.decode)
  Object.freeze(encode)
  Object.freeze(decode)

  return Object.freeze(value)
}

export const isMarkedCodecSnapshot = (value: unknown): boolean => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- arbitrary values may cross the Job boundary.
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return false
  }

  const snapshot = codecSnapshots.get(value)

  if (snapshot === undefined) {
    return false
  }

  try {
    const encode = Object.getOwnPropertyDescriptor(value, 'encode')?.value
    const decode = Object.getOwnPropertyDescriptor(value, 'decode')?.value

    return encode === snapshot.encode && decode === snapshot.decode
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
