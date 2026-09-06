import { TaggedError } from 'better-result'

import {
  sanitizeSchemaIdentifier,
  sanitizeSchemaIssues,
  type SchemaIssue
} from './internal/issues.js'

export type { SchemaIssue, SchemaIssuePath, SchemaIssuePathSegment } from './internal/issues.js'

export interface SchemaFailureOptions {
  readonly identifier?: unknown
  readonly operation?: unknown
  readonly cause?: unknown
  readonly issues?: unknown
}

interface SchemaFailureProps {
  readonly identifier: string
  readonly operation: string
  readonly issues: readonly SchemaIssue[]
  readonly message: string
}

const SchemaDecodeFailureBase = TaggedError('SchemaDecodeFailure')<{
  readonly identifier: string
  readonly operation: string
  readonly issues: readonly SchemaIssue[]
  readonly message: string
}>

const SchemaEncodeFailureBase = TaggedError('SchemaEncodeFailure')<{
  readonly identifier: string
  readonly operation: string
  readonly issues: readonly SchemaIssue[]
  readonly message: string
}>

const SchemaConstructionFailureBase = TaggedError('SchemaConstructionFailure')<{
  readonly identifier: string
  readonly operation: string
  readonly issues: readonly SchemaIssue[]
  readonly message: string
}>

const SchemaDefinitionFailureBase = TaggedError('SchemaDefinitionFailure')<{
  readonly identifier: string
  readonly operation: string
  readonly issues: readonly SchemaIssue[]
  readonly message: string
}>

const SchemaExecutionFailureBase = TaggedError('SchemaExecutionFailure')<{
  readonly identifier: string
  readonly operation: string
  readonly issues: readonly SchemaIssue[]
  readonly message: string
}>

const SchemaUnsupportedOperationBase = TaggedError('SchemaUnsupportedOperation')<{
  readonly identifier: string
  readonly operation: string
  readonly issues: readonly SchemaIssue[]
  readonly message: string
}>

const SchemaAsyncRequiredBase = TaggedError('SchemaAsyncRequired')<{
  readonly identifier: string
  readonly operation: string
  readonly issues: readonly SchemaIssue[]
  readonly message: string
}>

interface SchemaFailureJson<Tag extends string> extends SchemaFailureProps {
  readonly _tag: Tag
  readonly name: Tag
}

const SCHEMA_FAILURE_CAUSE = Symbol('better-effect-schema/schema-failure-cause')

const defineCause = (target: object, cause: unknown): void => {
  Object.defineProperty(target, SCHEMA_FAILURE_CAUSE, {
    configurable: false,
    enumerable: false,
    value: cause,
    writable: false
  })
}

const failureProps = (
  options: SchemaFailureOptions,
  fallbackOperation: string,
  message: string
): SchemaFailureProps => ({
  identifier: sanitizeSchemaIdentifier(options.identifier),
  operation: sanitizeSchemaIdentifier(options.operation ?? fallbackOperation),
  issues: sanitizeSchemaIssues(options.issues ?? options.cause),
  message
})

const failureJson = <Tag extends string>(
  tag: Tag,
  props: SchemaFailureProps
): SchemaFailureJson<Tag> =>
  Object.freeze({
    _tag: tag,
    name: tag,
    ...props
  })

/** Expected failure while decoding an encoded or unknown value. */
export class SchemaDecodeFailure extends SchemaDecodeFailureBase {
  declare private readonly [SCHEMA_FAILURE_CAUSE]: unknown

  override get cause(): unknown {
    return this[SCHEMA_FAILURE_CAUSE]
  }

  constructor(options: SchemaFailureOptions = {}) {
    super(failureProps(options, 'decode', 'Schema decoding failed'))
    defineCause(this, options.cause)
  }

  override toJSON(): SchemaFailureJson<'SchemaDecodeFailure'> {
    return failureJson(this._tag, this)
  }
}

/** Expected failure while encoding a decoded value. */
export class SchemaEncodeFailure extends SchemaEncodeFailureBase {
  declare private readonly [SCHEMA_FAILURE_CAUSE]: unknown

  override get cause(): unknown {
    return this[SCHEMA_FAILURE_CAUSE]
  }

  constructor(options: SchemaFailureOptions = {}) {
    super(failureProps(options, 'encode', 'Schema encoding failed'))
    defineCause(this, options.cause)
  }

  override toJSON(): SchemaFailureJson<'SchemaEncodeFailure'> {
    return failureJson(this._tag, this)
  }
}

/** Expected failure while constructing a schema class from decoded props. */
export class SchemaConstructionFailure extends SchemaConstructionFailureBase {
  declare private readonly [SCHEMA_FAILURE_CAUSE]: unknown

  override get cause(): unknown {
    return this[SCHEMA_FAILURE_CAUSE]
  }

  constructor(options: SchemaFailureOptions = {}) {
    super(failureProps(options, 'construction', 'Schema construction failed'))
    defineCause(this, options.cause)
  }

  override toJSON(): SchemaFailureJson<'SchemaConstructionFailure'> {
    return failureJson(this._tag, this)
  }
}

/** Failure caused by an invalid schema definition or declaration. */
export class SchemaDefinitionFailure extends SchemaDefinitionFailureBase {
  declare private readonly [SCHEMA_FAILURE_CAUSE]: unknown

  override get cause(): unknown {
    return this[SCHEMA_FAILURE_CAUSE]
  }

  constructor(options: SchemaFailureOptions = {}) {
    super(failureProps(options, 'definition', 'Schema definition is invalid'))
    defineCause(this, options.cause)
  }

  override toJSON(): SchemaFailureJson<'SchemaDefinitionFailure'> {
    return failureJson(this._tag, this)
  }
}

/** Unexpected failure from a provider, callback, constructor, or converter. */
export class SchemaExecutionFailure extends SchemaExecutionFailureBase {
  declare private readonly [SCHEMA_FAILURE_CAUSE]: unknown

  override get cause(): unknown {
    return this[SCHEMA_FAILURE_CAUSE]
  }

  constructor(options: SchemaFailureOptions = {}) {
    super(failureProps(options, 'execution', 'Schema operation failed during execution'))
    defineCause(this, options.cause)
  }

  override toJSON(): SchemaFailureJson<'SchemaExecutionFailure'> {
    return failureJson(this._tag, this)
  }
}

/** Failure for a capability or transformation that is not available. */
export class SchemaUnsupportedOperation extends SchemaUnsupportedOperationBase {
  declare private readonly [SCHEMA_FAILURE_CAUSE]: unknown

  override get cause(): unknown {
    return this[SCHEMA_FAILURE_CAUSE]
  }

  constructor(options: SchemaFailureOptions = {}) {
    super(failureProps(options, 'unsupported', 'Schema operation is unsupported'))
    defineCause(this, options.cause)
  }

  override toJSON(): SchemaFailureJson<'SchemaUnsupportedOperation'> {
    return failureJson(this._tag, this)
  }
}

/** Synchronous API received a Promise or thenable and must not run twice. */
export class SchemaAsyncRequired extends SchemaAsyncRequiredBase {
  declare private readonly [SCHEMA_FAILURE_CAUSE]: unknown

  override get cause(): unknown {
    return this[SCHEMA_FAILURE_CAUSE]
  }

  constructor(options: SchemaFailureOptions = {}) {
    super(failureProps(options, 'async', 'Schema operation requires the async API'))
    defineCause(this, options.cause)
  }

  override toJSON(): SchemaFailureJson<'SchemaAsyncRequired'> {
    return failureJson(this._tag, this)
  }
}
