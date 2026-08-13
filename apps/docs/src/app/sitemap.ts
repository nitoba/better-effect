import type { MetadataRoute } from 'next'
import { source } from '@/lib/source'
import { siteUrl } from '@/lib/shared'

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = source.getPages()

  return [
    {
      url: new URL('/', siteUrl).toString(),
      changeFrequency: 'weekly',
      priority: 1
    },
    ...pages.map((page) => ({
      url: new URL(page.url, siteUrl).toString(),
      changeFrequency: 'monthly' as const,
      priority: 0.8
    }))
  ]
}
