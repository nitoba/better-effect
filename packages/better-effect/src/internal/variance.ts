/** Type-level marker for a value produced by `A`. */
export type Covariant<A> = () => A

/** Type-level marker that both consumes and produces `A`. */
export type Invariant<A> = (value: A) => A
