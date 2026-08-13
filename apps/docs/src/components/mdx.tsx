import defaultMdxComponents from 'fumadocs-ui/mdx'
import type { MDXComponents } from 'mdx/types'
import { Accordions, Accordion } from './accordion'
import {
  CodeBlock,
  CodeBlockTab,
  CodeBlockTabs,
  CodeBlockTabsList,
  CodeBlockTabsTrigger,
  Pre
} from './codeblock'
import { File, Files, Folder } from './files'
import { InlineTOC } from './inline-toc'
import { Tab, Tabs, TabsContent, TabsList, TabsTrigger } from './tabs'

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    CodeBlock,
    CodeBlockTab,
    CodeBlockTabs,
    CodeBlockTabsList,
    CodeBlockTabsTrigger,
    File,
    Files,
    Folder,
    InlineTOC,
    Pre,
    Tab,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    ...components
  } satisfies MDXComponents
}

export const useMDXComponents = getMDXComponents

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>
}
