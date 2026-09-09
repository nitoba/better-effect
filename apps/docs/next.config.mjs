import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  serverExternalPackages: ['@takumi-rs/core'],
  async redirects() {
    const movedPages = [
      ['getting-started', 'start-here/getting-started'],
      ['mental-model', 'core/mental-model'],
      ['services', 'core/services'],
      ['effects', 'core/effects'],
      ['layers', 'core/layers'],
      ['runtime', 'core/runtime'],
      ['scope', 'core/scope'],
      ['resource', 'core/resource'],
      ['pipelines', 'core/pipelines'],
      ['errors', 'core/errors'],
      ['testing', 'core/testing'],
      ['web', 'integrations/web'],
      ['next', 'integrations/next'],
      ['hono', 'integrations/hono'],
      ['http', 'integrations/http'],
      ['schema', 'integrations/schema'],
      ['better-auth', 'integrations/better-auth'],
      ['kysely', 'integrations/kysely'],
      ['backends', 'integrations/backends'],
      ['packages', 'reference/packages'],
      ['migration', 'reference/migration'],
      ['todo-api', 'reference/todo-api'],
      ['patterns', 'reference/patterns'],
      ['troubleshooting', 'reference/troubleshooting'],
      ['mq/writing-a-driver', 'reference/writing-a-driver']
    ]

    return movedPages.map(([from, destination]) => ({
      source: `/docs/${from}`,
      destination: `/docs/${destination}`,
      permanent: true
    }))
  }
}

export default withMDX(config)
