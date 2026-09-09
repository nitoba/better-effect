'use client'
import type * as PageTree from 'fumadocs-core/page-tree'
import Image from 'next/image'
import { type ComponentProps, createContext, type ReactNode, use, useMemo, useState } from 'react'
import { cn } from '../../lib/cn'
import { TreeContextProvider, useTreeContext } from 'fumadocs-ui/contexts/tree'
import Link from 'fumadocs-core/link'
import { useSearchContext } from 'fumadocs-ui/contexts/search'
import { cva } from 'class-variance-authority'
import { usePathname } from 'fumadocs-core/framework'
import { Menu, Search, X } from 'lucide-react'

interface SidebarContext {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
}

const SidebarContext = createContext<SidebarContext | null>(null)

export interface DocsLayoutProps {
  tree: PageTree.Root
  children: ReactNode
}

export function DocsLayout({ tree, children }: DocsLayoutProps) {
  return (
    <TreeContextProvider tree={tree}>
      <SidebarProvider>
        <header className="be-docs-header sticky top-0 z-30 border-b bg-fd-background/90 backdrop-blur">
          <nav className="mx-auto flex h-14 w-full max-w-[1500px] items-center gap-3 px-4 md:px-6">
            <Link href="/" className="mr-auto font-medium">
              <span className="be-nav-brand">
                <Image src="/logo.svg" alt="" width={24} height={24} className="be-nav-logo" />
                <span>better-effect</span>
              </span>
            </Link>

            <SearchToggle />
            <NavbarSidebarTrigger className="md:hidden" />
          </nav>
        </header>
        <main
          id="nd-docs-layout"
          className="relative mx-auto flex w-full max-w-[1500px] flex-1 flex-row [--fd-nav-height:56px]"
        >
          <Sidebar />
          {children}
        </main>
      </SidebarProvider>
    </TreeContextProvider>
  )
}

function SidebarProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)

  return (
    <SidebarContext
      value={useMemo(
        () => ({
          open,
          setOpen
        }),
        [open]
      )}
    >
      {children}
    </SidebarContext>
  )
}

function SearchToggle(props: ComponentProps<'button'>) {
  const { enabled, setOpenSearch } = useSearchContext()
  if (!enabled) return

  return (
    <button
      {...props}
      type="button"
      aria-label="Search documentation"
      className={cn(
        'inline-flex h-9 items-center gap-2 rounded-lg border bg-fd-card px-3 text-sm text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground',
        props.className
      )}
      onClick={() => setOpenSearch(true)}
    >
      <Search className="size-4" aria-hidden="true" />
      <span className="hidden sm:inline">Search</span>
      <kbd className="hidden rounded border bg-fd-background px-1.5 py-0.5 text-[10px] sm:inline">
        ⌘ K
      </kbd>
    </button>
  )
}

function NavbarSidebarTrigger(props: ComponentProps<'button'>) {
  const { open, setOpen } = use(SidebarContext)!

  return (
    <button
      {...props}
      type="button"
      aria-label={open ? 'Close documentation navigation' : 'Open documentation navigation'}
      aria-expanded={open}
      className={cn(
        'inline-flex size-9 items-center justify-center rounded-lg border text-sm text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-accent-foreground',
        props.className
      )}
      onClick={() => setOpen(!open)}
    >
      {open ? <X className="size-4" /> : <Menu className="size-4" />}
    </button>
  )
}

function Sidebar() {
  const { root } = useTreeContext()
  const { open, setOpen } = use(SidebarContext)!

  const children = useMemo(() => {
    function renderItems(items: PageTree.Node[]) {
      return items.map((item) => (
        <SidebarItem key={item.$id} item={item}>
          {item.type === 'folder' ? renderItems(item.children) : null}
        </SidebarItem>
      ))
    }

    return renderItems(root.children)
  }, [root])

  return (
    <>
      <button
        type="button"
        aria-label="Close documentation navigation"
        className={cn(
          'fixed inset-0 top-14 z-20 bg-fd-overlay/40 backdrop-blur-sm md:hidden',
          !open && 'pointer-events-none invisible opacity-0'
        )}
        onClick={() => setOpen(false)}
      />
      <aside
        id="docs-sidebar"
        aria-label="Documentation navigation"
        className={cn(
          'fixed top-14 z-20 flex w-[min(88vw,340px)] flex-col overflow-auto border-e bg-fd-background p-4 text-sm shadow-xl transition-transform md:sticky md:h-[calc(100dvh-56px)] md:w-[300px] md:shrink-0 md:border-e-0 md:shadow-none',
          'max-md:inset-s-0',
          !open && 'max-md:-translate-x-full'
        )}
      >
        <p className="mb-3 px-2 text-xs font-semibold uppercase tracking-[0.14em] text-fd-muted-foreground">
          Explore the docs
        </p>
        {children}
      </aside>
    </>
  )
}

const linkVariants = cva(
  'flex items-center gap-2 w-full rounded-lg px-2 py-1.5 text-start text-fd-foreground/80 transition-colors [&_svg]:size-4',
  {
    variants: {
      active: {
        true: 'text-fd-primary font-medium',
        false: 'hover:text-fd-accent-foreground'
      }
    }
  }
)

function SidebarItem({ item, children }: { item: PageTree.Node; children: ReactNode }) {
  const pathname = usePathname()
  const { setOpen } = use(SidebarContext)!

  if (item.type === 'page') {
    return (
      <Link
        href={item.url}
        onClick={() => setOpen(false)}
        className={linkVariants({
          active: pathname === item.url
        })}
        aria-current={pathname === item.url ? 'page' : undefined}
      >
        {item.icon}
        {item.name}
      </Link>
    )
  }

  if (item.type === 'separator') {
    return (
      <p className="text-fd-muted-foreground mt-6 mb-2 first:mt-0">
        {item.icon}
        {item.name}
      </p>
    )
  }

  const folderIsActive = item.index
    ? pathname === item.index.url || pathname.startsWith(`${item.index.url}/`)
    : false

  return (
    <div>
      {item.index ? (
        <Link
          className={linkVariants({
            active: pathname === item.index.url
          })}
          href={item.index.url}
          onClick={() => setOpen(false)}
          aria-current={pathname === item.index.url ? 'page' : undefined}
        >
          {item.index.icon}
          {item.index.name}
        </Link>
      ) : (
        <p className={cn(linkVariants({ active: folderIsActive }), 'font-medium')}>
          {item.icon}
          {item.name}
        </p>
      )}
      <div className="pl-4 border-l flex flex-col">{children}</div>
    </div>
  )
}
