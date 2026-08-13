import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import Image from 'next/image'
import { appName, gitConfig } from './shared'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="be-nav-brand">
          <Image src="/logo.svg" alt="" width={24} height={24} className="be-nav-logo" />
          <span>{appName}</span>
        </span>
      )
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`
  }
}
