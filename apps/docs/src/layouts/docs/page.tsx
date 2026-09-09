'use client'
import { type ComponentProps, type ReactNode, useMemo } from 'react'
import { AnchorProvider, type TOCItemType, useActiveAnchors } from 'fumadocs-core/toc'
import { cn } from '../../lib/cn'
import { useTreeContext } from 'fumadocs-ui/contexts/tree'
import { Link, usePathname } from 'fumadocs-core/framework'
import type * as PageTree from 'fumadocs-core/page-tree'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { InlineTOC } from '../../components/inline-toc'

export interface BreadcrumbItem {
  name: string
  url?: string
}

export interface DocsPageProps {
  toc?: TOCItemType[]
  breadcrumb?: BreadcrumbItem[]

  children: ReactNode
}

export function DocsPage({ toc = [], breadcrumb = [], ...props }: DocsPageProps) {
  return (
    <AnchorProvider toc={toc}>
      <main className="be-docs-content flex w-full min-w-0 flex-col">
        <article className="mx-auto flex w-full max-w-[920px] flex-1 flex-col gap-6 px-5 py-8 md:px-8 md:py-12">
          {breadcrumb.length > 0 && <Breadcrumbs items={breadcrumb} />}
          {toc.length > 0 ? <InlineTOC items={toc} className="xl:hidden" /> : null}
          {props.children}
          <Footer />
        </article>
      </main>
      {toc.length > 0 && (
        <div className="sticky top-(--fd-nav-height) hidden h-[calc(100dvh-var(--fd-nav-height))] w-[286px] shrink-0 overflow-auto p-8 ps-4 xl:block">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-fd-muted-foreground">
            On this page
          </p>
          <div className="flex flex-col">
            {toc.map((item) => (
              <TocItem key={item.url} item={item} />
            ))}
          </div>
        </div>
      )}
    </AnchorProvider>
  )
}

export function DocsBody(props: ComponentProps<'div'>) {
  return (
    <div {...props} className={cn('prose', props.className)}>
      {props.children}
    </div>
  )
}

export function DocsDescription(props: ComponentProps<'p'>) {
  // don't render if no description provided
  if (props.children === undefined) return null

  return (
    <p {...props} className={cn('mb-8 text-lg text-fd-muted-foreground', props.className)}>
      {props.children}
    </p>
  )
}

export function DocsTitle(props: ComponentProps<'h1'>) {
  return (
    <h1
      {...props}
      className={cn('text-4xl font-semibold tracking-tight md:text-5xl', props.className)}
    >
      {props.children}
    </h1>
  )
}

function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex flex-wrap items-center gap-1.5 text-sm text-fd-muted-foreground"
    >
      {items.map((item, index) => (
        <span key={`${item.name}-${index}`} className="inline-flex items-center gap-1.5">
          {index > 0 ? <span aria-hidden="true">/</span> : null}
          {item.url && index < items.length - 1 ? (
            <Link href={item.url} className="transition-colors hover:text-fd-foreground">
              {item.name}
            </Link>
          ) : (
            <span className={index === items.length - 1 ? 'text-fd-foreground' : undefined}>
              {item.name}
            </span>
          )}
        </span>
      ))}
    </nav>
  )
}

function TocItem({ item }: { item: TOCItemType }) {
  const isActive = useActiveAnchors().includes(item.url.slice(1))

  return (
    <a
      href={item.url}
      className={cn(
        'border-s-2 border-transparent py-1.5 text-sm text-fd-foreground/70 transition-colors hover:text-fd-foreground',
        isActive && 'border-fd-primary text-fd-primary'
      )}
      style={{
        paddingInlineStart: 10 + Math.max(0, item.depth - 2) * 14
      }}
    >
      {item.title}
    </a>
  )
}

function Footer() {
  const { root } = useTreeContext()
  const pathname = usePathname()
  const flatten = useMemo(() => {
    const result: PageTree.Item[] = []

    function scan(items: PageTree.Node[]) {
      for (const item of items) {
        if (item.type === 'page') result.push(item)
        else if (item.type === 'folder') {
          if (item.index) result.push(item.index)
          scan(item.children)
        }
      }
    }

    scan(root.children)
    return result
  }, [root])

  const { previous, next } = useMemo(() => {
    const idx = flatten.findIndex((item) => item.url === pathname)

    if (idx === -1) return {}
    return {
      previous: flatten[idx - 1],
      next: flatten[idx + 1]
    }
  }, [flatten, pathname])

  return (
    <nav aria-label="Next steps" className="mt-12 grid gap-3 border-t pt-6 sm:grid-cols-2">
      {previous ? (
        <Link
          href={previous.url}
          className="group rounded-xl border p-4 text-start transition-colors hover:bg-fd-accent/60"
        >
          <span className="mb-2 flex items-center gap-2 text-xs text-fd-muted-foreground">
            <ArrowLeft className="size-3.5" aria-hidden="true" /> Previous
          </span>
          <span className="font-medium text-fd-foreground group-hover:text-fd-primary">
            {previous.name}
          </span>
          {previous.description ? (
            <span className="mt-1 block text-sm text-fd-muted-foreground">
              {previous.description}
            </span>
          ) : null}
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          href={next.url}
          className="group rounded-xl border p-4 text-end transition-colors hover:bg-fd-accent/60"
        >
          <span className="mb-2 flex items-center justify-end gap-2 text-xs text-fd-muted-foreground">
            Next step <ArrowRight className="size-3.5" aria-hidden="true" />
          </span>
          <span className="font-medium text-fd-foreground group-hover:text-fd-primary">
            {next.name}
          </span>
          {next.description ? (
            <span className="mt-1 block text-sm text-fd-muted-foreground">{next.description}</span>
          ) : null}
        </Link>
      ) : null}
    </nav>
  )
}
