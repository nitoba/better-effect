import { source } from '@/lib/source'
import { DocsLayout } from '@/layouts/docs'

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return <DocsLayout tree={source.getPageTree()}>{children}</DocsLayout>
}
