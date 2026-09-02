export type BodyOutcome<A, E> =
  | { readonly kind: 'not-started' }
  | { readonly kind: 'running' }
  | { readonly kind: 'success'; readonly value: A }
  | { readonly kind: 'failure'; readonly error: E }
  | { readonly kind: 'defect'; readonly cause: unknown }
  | { readonly kind: 'aborted'; readonly reason: unknown }
