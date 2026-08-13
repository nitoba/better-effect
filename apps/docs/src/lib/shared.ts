export const appName = 'better-effect'
export const appDescription =
  'Typed application architecture for Result-based TypeScript: explicit Services, composable Layers, predictable Runtime execution, and scoped resource lifetimes.'
export const appKeywords = [
  'TypeScript architecture',
  'better-result',
  'dependency injection',
  'services',
  'layers',
  'resource lifetimes',
  'effect systems'
]
export const docsRoute = '/docs'
export const docsImageRoute = '/og/docs'
export const docsContentRoute = '/llms.mdx/docs'
const configuredSiteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

export const siteUrl = new URL(configuredSiteUrl)
export const socialImagePath = '/opengraph-image'

// fill this with your actual GitHub info, for example:
export const gitConfig = {
  user: 'nitoba',
  repo: 'better-effect',
  branch: 'main'
}
