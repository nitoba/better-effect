import Link from 'next/link'
import type { ComponentProps, ReactNode } from 'react'
import {
  ArrowUpRight,
  ArrowRightLeft,
  BookMarked,
  Boxes,
  Brain,
  Cable,
  CircleHelp,
  Database,
  GitBranch,
  Globe,
  HardDrive,
  Layers,
  Layers3,
  ListChecks,
  ListTodo,
  Orbit,
  Play,
  Plug,
  Rocket,
  Send,
  ShieldCheck,
  TriangleAlert,
  WandSparkles,
  Zap
} from 'lucide-react'

const icons = {
  ArrowRightLeft,
  BookMarked,
  Boxes,
  Brain,
  Cable,
  CircleHelp,
  Database,
  GitBranch,
  Globe,
  HardDrive,
  Layers,
  Layers3,
  ListChecks,
  ListTodo,
  Orbit,
  Play,
  Plug,
  Rocket,
  Send,
  ShieldCheck,
  TriangleAlert,
  WandSparkles,
  Zap
} as const

type IconName = keyof typeof icons

export function DocCards({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={`be-doc-cards ${className ?? ''}`} {...props}>
      {children}
    </div>
  )
}

export function DocCard({
  href,
  title,
  icon,
  children
}: Readonly<{
  href: string
  title: string
  icon: IconName
  children: ReactNode
}>) {
  const Icon = icons[icon]

  return (
    <Link href={href} className="be-doc-card">
      <span className="be-doc-card-icon">
        <Icon aria-hidden="true" />
      </span>
      <span className="be-doc-card-copy">
        <span className="be-doc-card-title">{title}</span>
        <span className="be-doc-card-description">{children}</span>
      </span>
      <ArrowUpRight aria-hidden="true" className="be-doc-card-arrow" />
    </Link>
  )
}
