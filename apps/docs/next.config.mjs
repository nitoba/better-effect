import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  serverExternalPackages: ['@takumi-rs/core'],
  async redirects() {
    const movedPages = [
      ['getting-started', 'start-here/getting-started'],
      ['packages', 'start-here/packages'],
      ['todo-api', 'start-here/todo-api'],
      ['mental-model', 'core/mental-model'],
      ['services', 'core/services'],
      ['effects', 'core/effects'],
      ['layers', 'core/layers'],
      ['runtime', 'core/runtime'],
      ['scope', 'core/scope'],
      ['resource', 'core/resource'],
      ['pipelines', 'core/pipelines'],
      ['errors', 'core/errors'],
      ['backends', 'core/backends'],
      ['migration', 'core/migration'],
      ['http', 'integrations/http'],
      ['web', 'integrations/web'],
      ['hono', 'integrations/hono'],
      ['next', 'integrations/next'],
      ['kysely', 'integrations/kysely'],
      ['schema', 'integrations/schema'],
      ['better-auth', 'integrations/better-auth'],
      ['patterns', 'reference/patterns'],
      ['testing', 'reference/testing'],
      ['troubleshooting', 'reference/troubleshooting']
    ]

    return movedPages.map(([from, to]) => ({
      source: `/docs/${from}`,
      destination: `/docs/${to}`,
      permanent: true
    }))
  }
}

export default withMDX(config)
