import { ImageResponse } from 'next/og'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appDescription, appName } from '@/lib/shared'

export const alt = `${appName} — typed application architecture for TypeScript`
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function OpenGraphImage() {
  const logo = await readFile(join(process.cwd(), 'public', 'logo.png'))
  const logoData = `data:image/png;base64,${logo.toString('base64')}`

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '72px 78px',
        color: '#f4f4f1',
        background: '#050505',
        border: '1px solid #333',
        fontFamily: 'sans-serif'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
        <div
          style={{
            width: 96,
            height: 96,
            border: '1px solid #555',
            borderRadius: 22,
            background: '#111',
            backgroundImage: `url(${logoData})`,
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            backgroundSize: 'cover'
          }}
        />
        <div style={{ fontSize: 52, fontWeight: 600, letterSpacing: '-0.04em' }}>{appName}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 980 }}>
        <div style={{ fontSize: 40, lineHeight: 1.15, color: '#f4f4f1' }}>
          Results, Services, Lifetimes.
        </div>
        <div style={{ fontSize: 24, lineHeight: 1.35, color: '#999' }}>{appDescription}</div>
      </div>
    </div>,
    size
  )
}
