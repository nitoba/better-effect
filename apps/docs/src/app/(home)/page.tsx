import Link from 'next/link'

export default function HomePage() {
  return (
    <div className="flex flex-col justify-center text-center flex-1">
      <h1 className="text-4xl font-bold mb-4">better-effect</h1>
      <p className="text-fd-muted-foreground">
        Effect-inspired application architecture for better-result.
      </p>
      <p className="mt-4">
        Explore the{' '}
        <Link href="/docs" className="font-medium underline">
          documentation
        </Link>{' '}
        to get started.
      </p>
    </div>
  )
}
