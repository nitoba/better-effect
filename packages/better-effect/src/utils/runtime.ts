/** Detect a thenable while preserving the caller's value type. */
export const isPromiseLike = <Value>(value: Value): value is Value & PromiseLike<unknown> => {
  const candidate = Object(value)

  return 'then' in candidate && candidate.then instanceof Function
}
