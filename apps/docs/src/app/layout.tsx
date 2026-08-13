import { RootProvider } from 'fumadocs-ui/provider/next'
import './global.css'
import { Inter } from 'next/font/google'
import type { Metadata } from 'next'
import { appDescription, appKeywords, appName, siteUrl, socialImagePath } from '@/lib/shared'

const inter = Inter({
  subsets: ['latin']
})

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: {
    default: `${appName} — typed application architecture`,
    template: `%s | ${appName}`
  },
  description: appDescription,
  applicationName: appName,
  keywords: appKeywords,
  authors: [{ name: 'Nitoba', url: 'https://github.com/nitoba' }],
  creator: 'Nitoba',
  publisher: 'Nitoba',
  category: 'technology',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: appName,
    locale: 'en_US',
    title: `${appName} — typed application architecture`,
    description: appDescription,
    images: [
      {
        url: socialImagePath,
        width: 1200,
        height: 630,
        alt: `${appName} — typed application architecture for TypeScript`
      }
    ]
  },
  twitter: {
    card: 'summary_large_image',
    title: `${appName} — typed application architecture`,
    description: appDescription,
    images: [socialImagePath]
  },
  icons: {
    icon: [
      { url: '/favicon.ico', type: 'image/x-icon' },
      { url: '/icon.png', type: 'image/png', sizes: '512x512' }
    ],
    apple: [{ url: '/apple-icon.png', type: 'image/png', sizes: '180x180' }]
  },
  manifest: '/manifest.webmanifest',
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1
    }
  }
}

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  )
}
