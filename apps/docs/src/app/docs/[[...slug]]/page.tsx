import { getPageImageUrl, getPageMarkdownUrl, source } from '@/lib/source'
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  type BreadcrumbItem
} from '@/layouts/docs/page'
import { MarkdownCopyButton, ViewOptionsPopover } from 'fumadocs-ui/layouts/docs/page'
import { notFound } from 'next/navigation'
import { getMDXComponents } from '@/components/mdx'
import type { Metadata } from 'next'
import { createRelativeLink } from 'fumadocs-ui/mdx'
import { appName, gitConfig } from '@/lib/shared'
import { findPath } from 'fumadocs-core/page-tree'

export default async function Page(props: PageProps<'/docs/[[...slug]]'>) {
  const params = await props.params
  const page = source.getPage(params.slug)
  if (!page) notFound()

  const MDX = page.data.body
  const markdownUrl = getPageMarkdownUrl(page).url
  const tree = source.getPageTree()
  const pagePath = findPath(tree.children, (node) => node.type === 'page' && node.url === page.url)
  const breadcrumb: BreadcrumbItem[] = [{ name: 'Docs', url: '/docs' }]
  for (const [index, node] of (pagePath ?? []).entries()) {
    if (node.type === 'folder') {
      breadcrumb.push({
        name: String(node.name ?? ''),
        url: node.index?.url
      })
      continue
    }

    if (node.type !== 'page') continue
    const parent = pagePath?.[index - 1]
    if (parent?.type === 'folder' && parent.index?.url === node.url) continue
    breadcrumb.push({ name: String(node.name ?? '') })
  }

  return (
    <DocsPage toc={page.data.toc} breadcrumb={breadcrumb}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/apps/docs/content/docs/${page.path}`}
        />
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            // this allows you to link to other pages with relative file paths
            a: createRelativeLink(source, page)
          })}
        />
      </DocsBody>
    </DocsPage>
  )
}

export async function generateStaticParams() {
  return source.generateParams()
}

export async function generateMetadata(props: PageProps<'/docs/[[...slug]]'>): Promise<Metadata> {
  const params = await props.params
  const page = source.getPage(params.slug)
  if (!page) notFound()

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url
    },
    openGraph: {
      type: 'article',
      url: page.url,
      siteName: appName,
      title: page.data.title,
      description: page.data.description,
      images: [
        {
          url: getPageImageUrl(page).url,
          width: 1200,
          height: 630,
          alt: `${page.data.title} — ${appName} documentation`
        }
      ]
    },
    twitter: {
      card: 'summary_large_image',
      title: page.data.title,
      description: page.data.description,
      images: [getPageImageUrl(page).url]
    }
  }
}
