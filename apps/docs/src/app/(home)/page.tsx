import Image from 'next/image'
import Link from 'next/link'
import { ArrowUpRight, Braces, Layers3, Orbit } from 'lucide-react'

const pillars = [
  {
    icon: Braces,
    eyebrow: '01 / REQUIREMENTS',
    title: 'Dependencies you can see',
    description:
      'Services are tokens, contracts and yieldable handles. TypeScript follows every dependency from the generator to the Runtime.'
  },
  {
    icon: Layers3,
    eyebrow: '02 / COMPOSITION',
    title: 'Environments without a cage',
    description:
      'Layers describe implementations independently from your container. Merge production wiring and override only what tests need.'
  },
  {
    icon: Orbit,
    eyebrow: '03 / LIFETIMES',
    title: 'Ownership with an ending',
    description:
      'Scopes make resource ownership explicit: execution-local work closes fast, application resources close gracefully at shutdown.'
  }
]

export default function HomePage() {
  return (
    <main className="be-home">
      <section className="be-hero">
        <div className="be-hero-glow" aria-hidden="true" />
        <div className="be-hero-grid" aria-hidden="true" />

        <div className="be-hero-content">
          <div className="be-kicker">
            <span className="be-status-dot" />
            <span>TYPECHECKED APPLICATION ARCHITECTURE</span>
            <span className="be-kicker-rule" />
            <span className="be-kicker-version">v0.5</span>
          </div>

          <div className="be-hero-copy">
            <div className="be-brand-mark">
              <Image src="/logo.svg" alt="" width={72} height={72} priority />
            </div>
            <p className="be-display-label">RESULTS, SERVICES, LIFETIMES.</p>
            <h1>
              Make the shape
              <br />
              of your app <em>obvious.</em>
            </h1>
            <p className="be-hero-description">
              A small, typed architecture for TypeScript applications built on
              <span> better-result</span>. Compose dependencies, protect error boundaries and close
              what you open.
            </p>
            <div className="be-hero-actions">
              <Link href="/docs/getting-started" className="be-button be-button-primary">
                Start building <ArrowUpRight aria-hidden="true" />
              </Link>
              <Link href="/docs" className="be-button be-button-quiet">
                Read the docs <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>

          <div className="be-terminal" aria-label="Example better-effect program">
            <div className="be-terminal-bar">
              <span className="be-terminal-dots">
                <i />
                <i />
                <i />
              </span>
              <span>app.ts</span>
              <span className="be-terminal-state">better-effect / live</span>
            </div>
            <div className="be-terminal-body">
              <div className="be-line">
                <span className="be-ln">01</span>
                <span>
                  <b className="be-keyword">import</b> &#123; Effect, Layer, Runtime, Service &#125;{' '}
                  <b className="be-keyword">from</b>{' '}
                  <b className="be-string">&apos;better-effect&apos;</b>
                </span>
              </div>
              <div className="be-line">
                <span className="be-ln">02</span>
                <span>
                  <b className="be-keyword">import</b> &#123; Result &#125;{' '}
                  <b className="be-keyword">from</b>{' '}
                  <b className="be-string">&apos;better-result&apos;</b>
                </span>
              </div>
              <div className="be-line be-empty">
                <span className="be-ln">03</span>
                <span />
              </div>
              <div className="be-line">
                <span className="be-ln">04</span>
                <span>
                  <b className="be-keyword">class</b> <b className="be-class">Database</b>{' '}
                  <b className="be-keyword">extends</b> <b className="be-class">Service</b>&lt;
                  <b className="be-class">Database</b>&gt;()(
                  <b className="be-string">&apos;Database&apos;</b>) &#123;
                </span>
              </div>
              <div className="be-line">
                <span className="be-ln">05</span>
                <span>
                  &nbsp;&nbsp;<b className="be-function">query</b>(id:{' '}
                  <b className="be-type">string</b>) &#123; <b className="be-keyword">return</b> ...
                  &#125;
                </span>
              </div>
              <div className="be-line">
                <span className="be-ln">06</span>
                <span>&#125;</span>
              </div>
              <div className="be-line be-empty">
                <span className="be-ln">07</span>
                <span />
              </div>
              <div className="be-line">
                <span className="be-ln">08</span>
                <span>
                  <b className="be-keyword">const</b> program = <b className="be-class">Effect</b>.
                  <b className="be-function">gen</b>(<b className="be-keyword">function</b>* ()
                  =&gt; &#123;
                </span>
              </div>
              <div className="be-line">
                <span className="be-ln">09</span>
                <span>
                  &nbsp;&nbsp;<b className="be-keyword">const</b> db ={' '}
                  <b className="be-keyword">yield</b>* <b className="be-class">Database</b>
                </span>
              </div>
              <div className="be-line">
                <span className="be-ln">10</span>
                <span>
                  &nbsp;&nbsp;<b className="be-keyword">return</b>{' '}
                  <b className="be-class">Result</b>.<b className="be-function">ok</b>(
                  <b className="be-keyword">yield</b>* db.
                  <b className="be-function">query</b>(
                  <b className="be-string">&apos;user-1&apos;</b>))
                </span>
              </div>
              <div className="be-line">
                <span className="be-ln">11</span>
                <span>&#125;)</span>
              </div>
              <div className="be-line be-empty">
                <span className="be-ln">12</span>
                <span />
              </div>
              <div className="be-line">
                <span className="be-ln">13</span>
                <span>
                  <b className="be-comment">// requirements flow to the Runtime</b>
                </span>
              </div>
              <div className="be-line">
                <span className="be-ln">14</span>
                <span>
                  <b className="be-keyword">await</b> <b className="be-class">Runtime</b>.
                  <b className="be-function">run</b>(AppLive, backend, () =&gt; program)
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="be-intro-section">
        <div className="be-section-label">THE SMALL PATH</div>
        <div className="be-intro-grid">
          <h2>Keep the good parts of Effect. Keep your application yours.</h2>
          <div>
            <p>
              better-effect stays close to TypeScript, Promises and better-result. There is no
              hidden scheduler to learn and no container vocabulary in your domain code.
            </p>
            <Link href="/docs/mental-model" className="be-text-link">
              Learn the mental model <ArrowUpRight aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>

      <section className="be-pillars-section">
        <div className="be-section-label">THREE BOUNDARIES / ONE FLOW</div>
        <div className="be-pillars-grid">
          {pillars.map((pillar) => {
            const Icon = pillar.icon
            return (
              <article className="be-pillar" key={pillar.eyebrow}>
                <div className="be-pillar-icon">
                  <Icon aria-hidden="true" />
                </div>
                <p className="be-pillar-eyebrow">{pillar.eyebrow}</p>
                <h3>{pillar.title}</h3>
                <p>{pillar.description}</p>
              </article>
            )
          })}
        </div>
      </section>

      <section className="be-cta-section">
        <div className="be-cta-image">
          <Image
            src="/banner.svg"
            alt="better-effect"
            fill
            sizes="(max-width: 900px) 100vw, 55vw"
          />
        </div>
        <div className="be-cta-copy">
          <div className="be-section-label">READY WHEN YOU ARE</div>
          <h2>
            Start with one Service.
            <br />
            <em>Grow with confidence.</em>
          </h2>
          <p>
            Read the guide, wire your first Layer and let the compiler show you what your
            application needs.
          </p>
          <Link href="/docs/getting-started" className="be-button be-button-primary">
            Open the guide <ArrowUpRight aria-hidden="true" />
          </Link>
        </div>
      </section>

      <footer className="be-home-footer">
        <div className="be-footer-brand">
          <Image src="/logo.svg" alt="" width={28} height={28} /> <span>better-effect</span>
        </div>
        <span>Typed wiring for Result-based TypeScript.</span>
        <Link href="/docs">
          Documentation <ArrowUpRight aria-hidden="true" />
        </Link>
      </footer>
    </main>
  )
}
