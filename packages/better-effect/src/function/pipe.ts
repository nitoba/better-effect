type Unary<A, B> = (value: A) => B

/**
 * Compose a value through a sequence of unary functions.
 *
 * `pipe` is deliberately independent of Effect, Result, Promise, Scope, and
 * Service metadata.
 *
 * @example
 * ```ts
 * const label = pipe(
 *   'alice',
 *   (name) => name.trim(),
 *   (name) => name.toUpperCase()
 * )
 * ```
 */
type PipeRuntimeValue = Parameters<Unary<any, any>>[0]

type PipeRuntimeOperation = Unary<PipeRuntimeValue, PipeRuntimeValue>

export function pipe<A>(value: A): A
export function pipe<A, B>(value: A, ab: Unary<A, B>): B
export function pipe<A, B, C>(value: A, ab: Unary<A, B>, bc: Unary<B, C>): C
export function pipe<A, B, C, D>(value: A, ab: Unary<A, B>, bc: Unary<B, C>, cd: Unary<C, D>): D
export function pipe<A, B, C, D, E>(
  value: A,
  ab: Unary<A, B>,
  bc: Unary<B, C>,
  cd: Unary<C, D>,
  de: Unary<D, E>
): E
export function pipe<A, B, C, D, E, F>(
  value: A,
  ab: Unary<A, B>,
  bc: Unary<B, C>,
  cd: Unary<C, D>,
  de: Unary<D, E>,
  ef: Unary<E, F>
): F
export function pipe<A, B, C, D, E, F, G>(
  value: A,
  ab: Unary<A, B>,
  bc: Unary<B, C>,
  cd: Unary<C, D>,
  de: Unary<D, E>,
  ef: Unary<E, F>,
  fg: Unary<F, G>
): G
export function pipe<A, B, C, D, E, F, G, H>(
  value: A,
  ab: Unary<A, B>,
  bc: Unary<B, C>,
  cd: Unary<C, D>,
  de: Unary<D, E>,
  ef: Unary<E, F>,
  fg: Unary<F, G>,
  gh: Unary<G, H>
): H
export function pipe<A, B, C, D, E, F, G, H, I>(
  value: A,
  ab: Unary<A, B>,
  bc: Unary<B, C>,
  cd: Unary<C, D>,
  de: Unary<D, E>,
  ef: Unary<E, F>,
  fg: Unary<F, G>,
  gh: Unary<G, H>,
  hi: Unary<H, I>
): I
export function pipe<A, B, C, D, E, F, G, H, I, J>(
  value: A,
  ab: Unary<A, B>,
  bc: Unary<B, C>,
  cd: Unary<C, D>,
  de: Unary<D, E>,
  ef: Unary<E, F>,
  fg: Unary<F, G>,
  gh: Unary<G, H>,
  hi: Unary<H, I>,
  ij: Unary<I, J>
): J
export function pipe<A, B, C, D, E, F, G, H, I, J, K>(
  value: A,
  ab: Unary<A, B>,
  bc: Unary<B, C>,
  cd: Unary<C, D>,
  de: Unary<D, E>,
  ef: Unary<E, F>,
  fg: Unary<F, G>,
  gh: Unary<G, H>,
  hi: Unary<H, I>,
  ij: Unary<I, J>,
  jk: Unary<J, K>
): K
export function pipe(
  value: PipeRuntimeValue,
  ...operations: ReadonlyArray<PipeRuntimeOperation>
): PipeRuntimeValue {
  return operations.reduce((current, operation) => operation(current), value)
}
