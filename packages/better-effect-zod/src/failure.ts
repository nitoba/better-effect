import type * as z from "zod"
import { TaggedError } from "better-result"

import {
  sanitizeSchemaIdentifier,
  sanitizeSchemaIssues,
  type SchemaIssue
} from "./internal/issues.js"

export type { SchemaIssue, SchemaIssuePath, SchemaIssuePathSegment } from "./internal/issues.js"

export interface SchemaFailureOptions {
  readonly identifier: string
  readonly cause: z.ZodError
}

interface SchemaFailureJson<Tag extends string> {
  readonly _tag: Tag
  readonly name: Tag
  readonly message: string
  readonly identifier: string
  readonly issues: readonly SchemaIssue[]
}

const SCHEMA_FAILURE_CAUSE = Symbol("better-effect-zod/schema-failure-cause")

const defineCause = (target: object, cause: z.ZodError): void => {
  Object.defineProperty(target, SCHEMA_FAILURE_CAUSE, {
    configurable: false,
    enumerable: false,
    value: cause,
    writable: false
  })
}

const failureProps = (
  identifier: string,
  cause: z.ZodError,
  message: string
): {
  readonly identifier: string
  readonly issues: readonly SchemaIssue[]
  readonly message: string
} => ({
  identifier: sanitizeSchemaIdentifier(identifier),
  issues: sanitizeSchemaIssues(cause),
  message
})

/** Expected failure while decoding an encoded or unknown value. */
export class SchemaDecodeFailure extends TaggedError("SchemaDecodeFailure")<{
  readonly identifier: string
  readonly issues: readonly SchemaIssue[]
  readonly message: string
}> {
  declare private readonly [SCHEMA_FAILURE_CAUSE]: z.ZodError

  override get cause(): z.ZodError {
    return this[SCHEMA_FAILURE_CAUSE]
  }

  constructor(options: SchemaFailureOptions) {
    super(failureProps(options.identifier, options.cause, "Schema decoding failed"))
    defineCause(this, options.cause)
  }

  override toJSON(): SchemaFailureJson<"SchemaDecodeFailure"> {
    return Object.freeze({
      _tag: this._tag,
      name: this._tag,
      message: this.message,
      identifier: this.identifier,
      issues: this.issues
    })
  }
}

/** Expected failure while encoding a decoded value. */
export class SchemaEncodeFailure extends TaggedError("SchemaEncodeFailure")<{
  readonly identifier: string
  readonly issues: readonly SchemaIssue[]
  readonly message: string
}> {
  declare private readonly [SCHEMA_FAILURE_CAUSE]: z.ZodError

  override get cause(): z.ZodError {
    return this[SCHEMA_FAILURE_CAUSE]
  }

  constructor(options: SchemaFailureOptions) {
    super(failureProps(options.identifier, options.cause, "Schema encoding failed"))
    defineCause(this, options.cause)
  }

  override toJSON(): SchemaFailureJson<"SchemaEncodeFailure"> {
    return Object.freeze({
      _tag: this._tag,
      name: this._tag,
      message: this.message,
      identifier: this.identifier,
      issues: this.issues
    })
  }
}

/** Expected failure while constructing a schema class from decoded props. */
export class SchemaConstructionFailure extends TaggedError(
  "SchemaConstructionFailure"
)<{
  readonly identifier: string
  readonly issues: readonly SchemaIssue[]
  readonly message: string
}> {
  declare private readonly [SCHEMA_FAILURE_CAUSE]: z.ZodError

  override get cause(): z.ZodError {
    return this[SCHEMA_FAILURE_CAUSE]
  }

  constructor(options: SchemaFailureOptions) {
    super(failureProps(options.identifier, options.cause, "Schema construction failed"))
    defineCause(this, options.cause)
  }

  override toJSON(): SchemaFailureJson<"SchemaConstructionFailure"> {
    return Object.freeze({
      _tag: this._tag,
      name: this._tag,
      message: this.message,
      identifier: this.identifier,
      issues: this.issues
    })
  }
}
