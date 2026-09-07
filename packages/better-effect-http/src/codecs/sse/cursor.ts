export type SseCursorFrame = Readonly<{
  readonly id: string
  readonly hasData: boolean
}>

type CursorFrameHandler = (frame: SseCursorFrame) => void

/** Tracks protocol cursor updates only when an SSE frame reaches its delimiter. */
export class SseCursor {
  private line = ''
  private skipLf = false
  private current: string
  private hasData = false

  constructor(initial = '') {
    this.current = initial
  }

  get value(): string {
    return this.current
  }

  feed(chunk: string, onFrame: CursorFrameHandler): void {
    for (const character of chunk) {
      if (this.skipLf) {
        this.skipLf = false
        if (character === '\n') continue
      }
      if (character === '\r') {
        this.finishLine(onFrame)
        this.skipLf = true
      } else if (character === '\n') {
        this.finishLine(onFrame)
      } else {
        this.line += character
      }
    }
  }

  private finishLine(onFrame: CursorFrameHandler): void {
    if (this.line === '') {
      onFrame({ id: this.current, hasData: this.hasData })
      this.hasData = false
      this.line = ''
      return
    }
    const separator = this.line.indexOf(':')
    const field = separator < 0 ? this.line : this.line.slice(0, separator)
    let value = separator < 0 ? '' : this.line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'id') {
      if (!value.includes('\0')) this.current = value
    } else if (field === 'data') {
      this.hasData = true
    }
    this.line = ''
  }
}
