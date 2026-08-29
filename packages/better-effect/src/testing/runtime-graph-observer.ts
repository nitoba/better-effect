import type {
  RuntimeObserver,
  RuntimeServiceAcquireEvent,
  RuntimeServiceResolveEvent
} from '../runtime/observer'
import type { AnyServiceToken } from '../service'

/** One logical Service node in a Runtime graph snapshot. */
export type RuntimeGraphNode = {
  readonly tag: string
  readonly resolutions: number
  readonly acquisitions: number
  readonly failures: number
}

/** One observed parent-to-child Service edge in a Runtime graph snapshot. */
export type RuntimeGraphEdge = {
  readonly from: string
  readonly to: string
  readonly resolutions: number
}

/** Detached, sorted and immutable Runtime graph data. */
export type RuntimeGraphSnapshot = {
  readonly nodes: readonly RuntimeGraphNode[]
  readonly edges: readonly RuntimeGraphEdge[]
}

/** Options for a diagnostic Runtime graph observer. */
export type RuntimeGraphObserverOptions = {
  /** Count failed resolution and acquisition events in each node's failures field. */
  readonly includeFailures?: boolean
  /** Add this label as a synthetic root in Mermaid output for top-level resolutions. */
  readonly rootLabel?: string
}

type MutableGraphNode = {
  resolutions: number
  acquisitions: number
  failures: number
}

type MutableGraphEdge = {
  from: string
  to: string
  resolutions: number
}

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const compareEdges = (left: RuntimeGraphEdge, right: RuntimeGraphEdge): number =>
  compareStrings(left.from, right.from) || compareStrings(left.to, right.to)

const freezeNode = (node: RuntimeGraphNode): RuntimeGraphNode => Object.freeze({ ...node })

const freezeEdge = (edge: RuntimeGraphEdge): RuntimeGraphEdge => Object.freeze({ ...edge })

const serviceTags = (path: readonly AnyServiceToken[], targetTag: string): string[] => {
  const tags = path.map((service) => service.serviceTag)

  if (tags[tags.length - 1] !== targetTag) {
    tags.push(targetTag)
  }

  return tags
}

const mermaidLabelPunctuation = new Set([
  '&',
  '"',
  "'",
  '\\',
  '[',
  ']',
  '(',
  ')',
  '{',
  '}',
  '|',
  '#',
  ';',
  // Mermaid rewrites fa:fa-* label text into icon elements after decoding entities.
  ':',
  '<',
  '>',
  '=',
  '`',
  '*',
  '_',
  '~',
  '!',
  '^',
  '$'
])

const isMermaidLabelControl = (character: string, codePoint: number): boolean =>
  codePoint <= 0x1f ||
  (codePoint >= 0x7f && codePoint <= 0x9f) ||
  (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
  (/\s/u.test(character) && character !== ' ') ||
  /\p{Cf}/u.test(character)

/**
 * Escape Mermaid syntax while keeping the decoded label readable.
 *
 * Mermaid's documented `#number;` form is a syntax-level escape. Encoding the
 * entity introducers themselves prevents label text from creating a second
 * entity, while encoding Markdown and HTML punctuation keeps it out of the
 * renderer's interpretation paths.
 */
const escapeMermaidLabel = (label: string): string => {
  let escaped = ''

  for (const character of label) {
    const codePoint = character.codePointAt(0)

    if (codePoint === undefined) {
      continue
    }

    if (isMermaidLabelControl(character, codePoint) || mermaidLabelPunctuation.has(character)) {
      escaped += `#${codePoint};`
    } else {
      escaped += character
    }
  }

  return escaped
}

/** Encode a string as a Mermaid-safe, injective and registration-order-independent ID. */
const mermaidId = (prefix: string, value: string): string => {
  const codeUnits: string[] = []

  for (let index = 0; index < value.length; index += 1) {
    codeUnits.push(value.charCodeAt(index).toString(16).padStart(4, '0'))
  }

  return `${prefix}${codeUnits.join('_') || 'empty'}`
}

/**
 * Observe the public Runtime resolution and acquisition events as a diagnostic graph.
 *
 * The graph is deliberately an observation of paths emitted by Runtime. It does
 * not inspect Layer provenance, retain Service instances, or plan dependencies.
 */
export class RuntimeGraphObserver implements RuntimeObserver {
  private readonly nodes = new Map<string, MutableGraphNode>()
  private readonly edges = new Map<string, Map<string, MutableGraphEdge>>()
  private readonly rootEdges = new Map<string, number>()

  private constructor(
    private readonly includeFailures: boolean,
    private readonly rootLabel: string | undefined
  ) {}

  /** Create an empty Runtime graph observer. */
  static make(options: RuntimeGraphObserverOptions = {}): RuntimeGraphObserver {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate JavaScript callers at the public factory boundary.
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('RuntimeGraphObserver options must be an object')
    }

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate JavaScript callers at the public factory boundary.
    if (options.includeFailures !== undefined && typeof options.includeFailures !== 'boolean') {
      throw new TypeError('RuntimeGraphObserver includeFailures must be a boolean')
    }

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate JavaScript callers at the public factory boundary.
    if (options.rootLabel !== undefined && typeof options.rootLabel !== 'string') {
      throw new TypeError('RuntimeGraphObserver rootLabel must be a string')
    }

    return new RuntimeGraphObserver(options.includeFailures ?? true, options.rootLabel)
  }

  readonly onServiceResolve = (event: RuntimeServiceResolveEvent): void => {
    const targetTag = event.service.serviceTag
    const path = serviceTags(event.resolutionPath, targetTag)
    const node = this.ensureNode(targetTag)

    this.ensurePath(path)
    node.resolutions += 1

    if (event.outcome.status === 'failure' && this.includeFailures) {
      node.failures += 1
    }

    const parentTag = path[path.length - 2]

    if (parentTag === undefined) {
      if (this.rootLabel !== undefined) {
        this.rootEdges.set(targetTag, (this.rootEdges.get(targetTag) ?? 0) + 1)
      }

      return
    }

    const targets = this.edges.get(parentTag) ?? new Map<string, MutableGraphEdge>()
    const edge =
      targets.get(targetTag) ??
      (() => {
        const created: MutableGraphEdge = { from: parentTag, to: targetTag, resolutions: 0 }
        targets.set(targetTag, created)
        return created
      })()

    edge.resolutions += 1
    this.edges.set(parentTag, targets)
  }

  readonly onServiceAcquire = (event: RuntimeServiceAcquireEvent): void => {
    const targetTag = event.service.serviceTag
    const path = serviceTags(event.resolutionPath, targetTag)
    const node = this.ensureNode(targetTag)

    this.ensurePath(path)
    node.acquisitions += 1

    if (event.outcome.status === 'failure' && this.includeFailures) {
      node.failures += 1
    }
  }

  /** Return a fresh, deeply detached and sorted graph snapshot. */
  toJSON(): RuntimeGraphSnapshot {
    const nodes = Object.freeze(
      [...this.nodes.entries()]
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([tag, counters]) =>
          freezeNode({
            tag,
            resolutions: counters.resolutions,
            acquisitions: counters.acquisitions,
            failures: counters.failures
          })
        )
    )
    const edges = Object.freeze(
      [...this.edges.values()]
        .flatMap((targets) => [...targets.values()])
        .map((edge) => freezeEdge({ ...edge }))
        .sort(compareEdges)
    )

    return Object.freeze({ nodes, edges })
  }

  /** Render the current graph as deterministic Mermaid flowchart source. */
  toMermaid(): string {
    const snapshot = this.toJSON()
    const serviceIds = new Map(
      snapshot.nodes.map((node) => [node.tag, mermaidId('service_', node.tag)])
    )
    const lines = ['flowchart TD']
    const rootTargets = [...this.rootEdges.entries()].sort(([left], [right]) =>
      compareStrings(left, right)
    )
    const root =
      this.rootLabel !== undefined && rootTargets.length > 0
        ? { id: mermaidId('root_', this.rootLabel), label: this.rootLabel }
        : undefined

    if (root !== undefined) {
      lines.push(`  ${root.id}["${escapeMermaidLabel(root.label)}"]`)
    }

    for (const node of snapshot.nodes) {
      const id = serviceIds.get(node.tag)

      if (id !== undefined) {
        lines.push(`  ${id}["${escapeMermaidLabel(node.tag)}"]`)
      }
    }

    if (root !== undefined) {
      for (const [targetTag, resolutions] of rootTargets) {
        const targetId = serviceIds.get(targetTag)

        if (targetId !== undefined) {
          lines.push(`  ${root.id} -->|${resolutions}| ${targetId}`)
        }
      }
    }

    for (const edge of snapshot.edges) {
      const fromId = serviceIds.get(edge.from)
      const toId = serviceIds.get(edge.to)

      if (fromId !== undefined && toId !== undefined) {
        lines.push(`  ${fromId} -->|${edge.resolutions}| ${toId}`)
      }
    }

    return lines.join('\n')
  }

  /** Discard all observed graph data while keeping this observer reusable. */
  clear(): void {
    this.nodes.clear()
    this.edges.clear()
    this.rootEdges.clear()
  }

  private ensureNode(tag: string): MutableGraphNode {
    const existing = this.nodes.get(tag)

    if (existing !== undefined) {
      return existing
    }

    const node: MutableGraphNode = { resolutions: 0, acquisitions: 0, failures: 0 }
    this.nodes.set(tag, node)
    return node
  }

  private ensurePath(path: readonly string[]): void {
    for (const tag of path) {
      this.ensureNode(tag)
    }
  }
}
