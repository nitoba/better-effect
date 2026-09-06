/** Stable codes for package-contract failures. Invalid data uses ZodError or typed schema failures. */
export type BetterEffectZodErrorCode =
  | "INVALID_DEFINITION"
  | "INVALID_IDENTIFIER"
  | "MISSING_DESCRIPTOR"
  | "INVALID_CONSTRUCTION"
  | "INVALID_DERIVATION"
  | "INVALID_TAG"

/** Error raised when the schema-class contract itself is used incorrectly. */
export class BetterEffectZodError extends Error {
  readonly code: BetterEffectZodErrorCode

  constructor(
    code: BetterEffectZodErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "BetterEffectZodError"
    this.code = code
  }
}

/** @deprecated Use `BetterEffectZodErrorCode`. */
export type ZodClassErrorCode = BetterEffectZodErrorCode

/** @deprecated Use `BetterEffectZodError`. */
export { BetterEffectZodError as ZodClassError }
