import { JSDOM } from 'jsdom'
import { describe, expect, test } from 'bun:test'

import { Layer, Runtime, RuntimeObserver, Service, ServiceRuntime } from '../src'
import {
  RecordedRuntimeObserver,
  RuntimeGraphObserver,
  type RuntimeGraphSnapshot
} from '../src/testing'

class LinearDatabase extends Service<LinearDatabase>()('graph/linear/Database') {}

class LinearRepository extends Service<LinearRepository>()('graph/linear/Repository') {}

class LinearApplication extends Service<LinearApplication>()('graph/linear/Application') {}

const linearLayer = Layer.merge(
  Layer.make(LinearDatabase),
  Layer.gen(LinearRepository, async function* () {
    yield* LinearDatabase
    return new LinearRepository()
  }),
  Layer.gen(LinearApplication, async function* () {
    yield* LinearRepository
    return new LinearApplication()
  })
)

class DiamondShared extends Service<DiamondShared>()('graph/diamond/Shared') {}

class DiamondLeft extends Service<DiamondLeft>()('graph/diamond/Left') {}

class DiamondRight extends Service<DiamondRight>()('graph/diamond/Right') {}

class DiamondRoot extends Service<DiamondRoot>()('graph/diamond/Root') {}

const diamondLayer = Layer.merge(
  Layer.make(DiamondShared),
  Layer.gen(DiamondLeft, async function* () {
    yield* DiamondShared
    return new DiamondLeft()
  }),
  Layer.gen(DiamondRight, async function* () {
    yield* DiamondShared
    return new DiamondRight()
  }),
  Layer.gen(DiamondRoot, async function* () {
    yield* DiamondLeft
    yield* DiamondRight
    return new DiamondRoot()
  })
)

const readSnapshot = (snapshot: RuntimeGraphSnapshot, tag: string) =>
  snapshot.nodes.find((node) => node.tag === tag)

const captureRejection = async (promise: Promise<unknown>): Promise<Error | undefined> =>
  promise.then(
    () => undefined,
    (cause) => (cause instanceof Error ? cause : new Error(String(cause)))
  )

type MermaidSecurityLevel = 'antiscript' | 'loose'

// Mermaid's dagre renderer needs SVG layout APIs absent from JSDOM. This
// deterministic measurement shim keeps the test focused on parsing and DOM
// interpretation without starting a browser or adding a runtime dependency.
const createMermaidDom = (): JSDOM => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/'
  })
  const { window } = dom

  Object.defineProperty(window.SVGElement.prototype, 'getBBox', {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 100, height: 30 })
  })
  Object.defineProperty(window.SVGElement.prototype, 'getComputedTextLength', {
    configurable: true,
    value: () => 100
  })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    SVGSVGElement: window.SVGSVGElement,
    DOMParser: window.DOMParser,
    XMLSerializer: window.XMLSerializer,
    CSSStyleSheet: window.CSSStyleSheet,
    CSSStyleDeclaration: window.CSSStyleDeclaration,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window)
  })

  return dom
}

let mermaidDom: JSDOM | undefined
let mermaid: typeof import('mermaid').default | undefined
let mermaidRenderId = 0

const renderMermaid = async (
  source: string,
  securityLevel: MermaidSecurityLevel
): Promise<JSDOM> => {
  mermaidDom ??= createMermaidDom()
  mermaid ??= (await import('mermaid')).default
  mermaid.initialize({ startOnLoad: false, securityLevel })
  await mermaid.parse(source)
  const result = await mermaid.render(`runtime-graph-test-${mermaidRenderId++}`, source)
  return new JSDOM(result.svg)
}

describe('RuntimeGraphObserver', () => {
  test('observes a linear transitive graph from public resolution paths', async () => {
    const graph = RuntimeGraphObserver.make()
    const runtime = await Runtime.make(linearLayer, { observers: [graph] })

    try {
      const application = await runtime.run(() => ServiceRuntime.resolve(LinearApplication))

      expect(application).toBeInstanceOf(LinearApplication)
      expect(graph.toJSON()).toEqual({
        nodes: [
          {
            tag: 'graph/linear/Application',
            resolutions: 1,
            acquisitions: 1,
            failures: 0
          },
          {
            tag: 'graph/linear/Database',
            resolutions: 1,
            acquisitions: 1,
            failures: 0
          },
          {
            tag: 'graph/linear/Repository',
            resolutions: 1,
            acquisitions: 1,
            failures: 0
          }
        ],
        edges: [
          {
            from: 'graph/linear/Application',
            to: 'graph/linear/Repository',
            resolutions: 1
          },
          {
            from: 'graph/linear/Repository',
            to: 'graph/linear/Database',
            resolutions: 1
          }
        ]
      })
    } finally {
      await runtime.dispose()
    }
  })

  test('aggregates diamond edges and cached shared acquisitions', async () => {
    const graph = RuntimeGraphObserver.make()
    const runtime = await Runtime.make(diamondLayer, { observers: [graph] })

    try {
      await runtime.run(() => ServiceRuntime.resolve(DiamondRoot))

      const snapshot = graph.toJSON()
      expect(readSnapshot(snapshot, 'graph/diamond/Shared')).toEqual({
        tag: 'graph/diamond/Shared',
        resolutions: 2,
        acquisitions: 1,
        failures: 0
      })
      expect(snapshot.edges).toEqual([
        {
          from: 'graph/diamond/Left',
          to: 'graph/diamond/Shared',
          resolutions: 1
        },
        {
          from: 'graph/diamond/Right',
          to: 'graph/diamond/Shared',
          resolutions: 1
        },
        {
          from: 'graph/diamond/Root',
          to: 'graph/diamond/Left',
          resolutions: 1
        },
        {
          from: 'graph/diamond/Root',
          to: 'graph/diamond/Right',
          resolutions: 1
        }
      ])
    } finally {
      await runtime.dispose()
    }
  })

  test('keeps repeated cached resolutions on one logical node and edge', async () => {
    const graph = RuntimeGraphObserver.make()
    const runtime = await Runtime.make(linearLayer, { observers: [graph] })

    try {
      await Promise.all(
        [LinearApplication, LinearApplication, LinearApplication].map((service) =>
          runtime.run(() => ServiceRuntime.resolve(service))
        )
      )

      const snapshot = graph.toJSON()
      expect(readSnapshot(snapshot, 'graph/linear/Application')).toMatchObject({
        resolutions: 3,
        acquisitions: 1,
        failures: 0
      })
      expect(snapshot.edges).toContainEqual({
        from: 'graph/linear/Application',
        to: 'graph/linear/Repository',
        resolutions: 1
      })
    } finally {
      await runtime.dispose()
    }
  })

  test('does not invent nodes for lazy providers and observes all providers during warmup', async () => {
    const lazyGraph = RuntimeGraphObserver.make()
    const lazyRuntime = await Runtime.make(linearLayer, { observers: [lazyGraph] })

    try {
      expect(lazyGraph.toJSON()).toEqual({ nodes: [], edges: [] })
      await lazyRuntime.run(() => ServiceRuntime.resolve(LinearRepository))
      expect(lazyGraph.toJSON().nodes.map((node) => node.tag)).toEqual([
        'graph/linear/Database',
        'graph/linear/Repository'
      ])
    } finally {
      await lazyRuntime.dispose()
    }

    const warmupGraph = RuntimeGraphObserver.make()
    const warmupRuntime = await Runtime.make(linearLayer, {
      observers: [warmupGraph],
      warmup: true
    })

    try {
      const snapshot = warmupGraph.toJSON()
      expect(snapshot.nodes.map((node) => node.tag)).toEqual([
        'graph/linear/Application',
        'graph/linear/Database',
        'graph/linear/Repository'
      ])
      expect(snapshot.edges).toEqual([
        {
          from: 'graph/linear/Application',
          to: 'graph/linear/Repository',
          resolutions: 1
        },
        {
          from: 'graph/linear/Repository',
          to: 'graph/linear/Database',
          resolutions: 1
        }
      ])
    } finally {
      await warmupRuntime.dispose()
    }
  })

  test('counts resolution and acquisition failures without serializing causes', async () => {
    class FailingService extends Service<FailingService>()('graph/failure/Service') {}

    const failure = new Error('do-not-export-this-cause')
    const graph = RuntimeGraphObserver.make()
    const runtime = await Runtime.make(
      Layer.make(FailingService, () => {
        throw failure
      }),
      { observers: [graph] }
    )

    try {
      expect(
        await captureRejection(runtime.run(() => ServiceRuntime.resolve(FailingService)))
      ).toBeInstanceOf(Error)

      const snapshot = graph.toJSON()
      expect(snapshot.nodes).toEqual([
        {
          tag: 'graph/failure/Service',
          resolutions: 1,
          acquisitions: 1,
          failures: 2
        }
      ])
      expect(JSON.stringify(snapshot)).not.toContain('do-not-export-this-cause')
      expect(graph.toMermaid()).not.toContain('do-not-export-this-cause')
    } finally {
      await runtime.dispose()
    }
  })

  test('keeps compatible same-tag overrides as one logical node', async () => {
    class OriginalService extends Service<OriginalService>()('graph/override/Service') {
      read(): string {
        return 'original'
      }
    }

    class ReplacementService extends Service<ReplacementService>()('graph/override/Service') {
      read(): string {
        return 'replacement'
      }
    }

    const graph = RuntimeGraphObserver.make()
    const runtime = await Runtime.make(
      Layer.override(Layer.make(OriginalService), Layer.make(ReplacementService)),
      { observers: [graph] }
    )

    try {
      const service = await runtime.run(() => ServiceRuntime.resolve(ReplacementService))

      expect(service.read()).toBe('replacement')
      expect(graph.toJSON().nodes).toEqual([
        {
          tag: 'graph/override/Service',
          resolutions: 1,
          acquisitions: 1,
          failures: 0
        }
      ])
      expect(JSON.stringify(graph.toJSON())).not.toContain('ReplacementService')
    } finally {
      await runtime.dispose()
    }
  })

  test('keeps concurrent path counters and relationships independent', async () => {
    class ConcurrentParent extends Service<ConcurrentParent>()('graph/concurrent/Parent') {}
    class ConcurrentChild extends Service<ConcurrentChild>()('graph/concurrent/Child') {}
    let markParentStarted!: () => void
    let releaseParent!: () => void
    const parentStarted = new Promise<void>((resolve) => {
      markParentStarted = resolve
    })
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve
    })
    const graph = RuntimeGraphObserver.make()
    const runtime = await Runtime.make(
      Layer.merge(
        Layer.make(ConcurrentParent, async () => {
          markParentStarted()
          await parentGate
          return new ConcurrentParent()
        }),
        Layer.gen(ConcurrentChild, async function* () {
          yield* ConcurrentParent
          return new ConcurrentChild()
        })
      ),
      { observers: [graph] }
    )
    const runs = Array.from({ length: 20 }, () =>
      runtime.run(() => ServiceRuntime.resolve(ConcurrentChild))
    )

    try {
      await parentStarted
      releaseParent()
      await Promise.all(runs)

      expect(graph.toJSON()).toEqual({
        nodes: [
          {
            tag: 'graph/concurrent/Child',
            resolutions: 20,
            acquisitions: 1,
            failures: 0
          },
          {
            tag: 'graph/concurrent/Parent',
            resolutions: 1,
            acquisitions: 1,
            failures: 0
          }
        ],
        edges: [
          {
            from: 'graph/concurrent/Child',
            to: 'graph/concurrent/Parent',
            resolutions: 1
          }
        ]
      })
    } finally {
      releaseParent()
      await Promise.allSettled(runs)
      await runtime.dispose()
    }
  })

  test('renders unusual tags with deterministic collision-safe Mermaid IDs', async () => {
    const unusualTag = '@acme/Database "primary" [v1]|#'
    const unusualDependencyTag = '@acme/Cache:primary, v1'
    class UnusualDependency extends Service<UnusualDependency>()(unusualDependencyTag) {}
    class UnusualService extends Service<UnusualService>()(unusualTag) {}

    const makeLayer = (reverse: boolean) => {
      const dependency = Layer.make(UnusualDependency)
      const service = Layer.gen(UnusualService, async function* () {
        yield* UnusualDependency
        return new UnusualService()
      })

      return reverse ? Layer.merge(dependency, service) : Layer.merge(service, dependency)
    }
    const makeGraphRuntime = (observer: RuntimeGraphObserver, reverse: boolean) =>
      Runtime.make(makeLayer(reverse), { observers: [observer] })
    const firstGraph = RuntimeGraphObserver.make({ rootLabel: 'Runtime "root"' })
    const secondGraph = RuntimeGraphObserver.make({ rootLabel: 'Runtime "root"' })
    const firstRuntime = await makeGraphRuntime(firstGraph, false)
    const secondRuntime = await makeGraphRuntime(secondGraph, true)

    try {
      await firstRuntime.run(() => ServiceRuntime.resolve(UnusualService))
      await secondRuntime.run(() => ServiceRuntime.resolve(UnusualService))

      const mermaid = firstGraph.toMermaid()
      expect(mermaid).toBe(secondGraph.toMermaid())
      expect(mermaid).toContain('flowchart TD')
      expect(mermaid).toContain('@acme/Database')
      expect(mermaid).toContain('@acme/Cache#58;primary, v1')
      expect(mermaid).toContain('#34;')
      expect(mermaid).toContain('#91;')
      expect(mermaid).toContain('#93;')
      expect(mermaid).toContain('#124;')
      expect(mermaid).not.toContain('service_@acme')
      expect(mermaid).toContain('-->|1|')
    } finally {
      await firstRuntime.dispose()
      await secondRuntime.dispose()
    }
  })

  test('parses and renders adversarial labels as literal text', async () => {
    const serviceTag =
      '<img src=x onerror=alert(1)> **bold** `code` &lt;entity&gt; &amp; #60; "quotes" \'single\' [brackets] | pipes fa:fa-twitter fab:fa-github fas:fa-skull'
    const rootLabel =
      'Runtime <img src=x onerror=alert(2)> **root** `markdown` &amp; &lt;root-entity&gt; [link](javascript:alert(3)) "root" fa:fa-twitter fab:fa-github fas:fa-skull'
    class LiteralLabelService extends Service<LiteralLabelService>()(serviceTag) {}
    const graph = RuntimeGraphObserver.make({ rootLabel })

    graph.onServiceResolve({
      service: LiteralLabelService,
      resolutionPath: [LiteralLabelService],
      outcome: { status: 'success' }
    })

    const source = graph.toMermaid()
    expect(source).toContain('flowchart TD')
    expect(source).toContain('#60;')
    expect(source).toContain('#62;')
    expect(source).toContain('#96;')
    expect(source).toContain('#38;')
    expect(source).not.toContain('<img')
    expect(source).not.toContain('**')
    expect(source).not.toContain('`code`')
    expect(source).not.toContain('&lt;entity&gt;')

    for (const securityLevel of ['loose', 'antiscript'] as const) {
      const rendered = await renderMermaid(source, securityLevel)
      const labels = [...rendered.window.document.querySelectorAll('.nodeLabel')]

      expect(labels.map((label) => label.textContent)).toEqual([rootLabel, serviceTag])

      for (const label of labels) {
        expect(
          label.querySelector(
            'a,area,embed,form,iframe,img,input,link,object,script,style,textarea,video,strong,em,code,i'
          )
        ).toBeNull()
        expect(label.querySelector('[onerror],[onclick],[href],[src]')).toBeNull()
      }
    }
  })

  test('encodes control and Unicode whitespace before Mermaid rendering', async () => {
    const serviceTag = 'unicode\u0000\t\u0085\u2028\u2029\u00a0\u200b\ufeff😀'
    const rootLabel = 'root\n\r\u000b\u2028\u2029\u00a0\u200d😀'
    class UnicodeLabelService extends Service<UnicodeLabelService>()(serviceTag) {}
    const graph = RuntimeGraphObserver.make({ rootLabel })

    graph.onServiceResolve({
      service: UnicodeLabelService,
      resolutionPath: [UnicodeLabelService],
      outcome: { status: 'success' }
    })

    const source = graph.toMermaid()
    for (const encoded of [
      '#0;',
      '#9;',
      '#11;',
      '#133;',
      '#160;',
      '#8203;',
      '#8205;',
      '#8232;',
      '#8233;',
      '#65279;'
    ]) {
      expect(source).toContain(encoded)
    }
    for (const control of ['\u0000', '\t', '\u0085', '\u2028', '\u2029', '\u200b', '\ufeff']) {
      expect(source).not.toContain(control)
    }

    for (const securityLevel of ['loose', 'antiscript'] as const) {
      const rendered = await renderMermaid(source, securityLevel)
      const labels = [...rendered.window.document.querySelectorAll('.nodeLabel')]

      expect(labels).toHaveLength(2)
      expect(labels.some((label) => label.textContent?.includes('unicode'))).toBe(true)
      expect(labels.some((label) => label.textContent?.includes('root'))).toBe(true)
      expect(
        labels.every(
          (label) =>
            label.querySelector(
              'a,area,embed,form,iframe,img,input,link,object,script,style,textarea,video,strong,em,code'
            ) === null
        )
      ).toBe(true)
    }
  })

  test('returns detached immutable snapshots and supports clear', () => {
    class SnapshotService extends Service<SnapshotService>()('graph/snapshot/Service') {}
    const graph = RuntimeGraphObserver.make()

    graph.onServiceResolve({
      service: SnapshotService,
      resolutionPath: [SnapshotService],
      outcome: { status: 'success' }
    })

    const beforeClear = graph.toJSON()
    expect(Object.isFrozen(beforeClear)).toBe(true)
    expect(Object.isFrozen(beforeClear.nodes)).toBe(true)
    expect(Object.isFrozen(beforeClear.nodes[0])).toBe(true)
    expect(Object.isFrozen(beforeClear.edges)).toBe(true)

    graph.clear()
    expect(graph.toJSON()).toEqual({ nodes: [], edges: [] })
    expect(beforeClear.nodes).toHaveLength(1)
  })

  test('composes with the recorder without duplicating lifecycle events', async () => {
    const graph = RuntimeGraphObserver.make()
    const recorder = RecordedRuntimeObserver.make()
    const runtime = await Runtime.make(Layer.make(LinearDatabase), {
      observers: [RuntimeObserver.compose(recorder, graph)]
    })

    try {
      await runtime.run(() => ServiceRuntime.resolve(LinearDatabase))
      expect(recorder.serviceResolutions).toHaveLength(1)
      expect(recorder.serviceAcquisitions).toHaveLength(1)
      expect(graph.toJSON().nodes).toEqual([
        {
          tag: 'graph/linear/Database',
          resolutions: 1,
          acquisitions: 1,
          failures: 0
        }
      ])
    } finally {
      await runtime.dispose()
    }
  })
})
