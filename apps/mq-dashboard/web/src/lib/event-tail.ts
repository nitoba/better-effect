export const MAX_EVENT_BUFFER = 200

export interface CursorEvent {
  readonly cursor: string
}

export interface EventTailState<Event extends CursorEvent> {
  readonly events: readonly Event[]
  readonly dropped: number
}

export interface EventStreamPathOptions {
  readonly after: string
  readonly queue?: string
  readonly type?: string
  readonly heartbeatMs?: number
}

export const appendEventToBuffer = <Event extends CursorEvent>(
  events: readonly Event[],
  next: Event,
  dropped = 0,
  max = MAX_EVENT_BUFFER
): EventTailState<Event> => {
  const combined = [...events, next]
  const overflow = Math.max(0, combined.length - max)
  return {
    events: combined.slice(-max),
    dropped: dropped + overflow
  }
}

export const eventStreamPath = (options: EventStreamPathOptions): string => {
  const query = new URLSearchParams({
    limit: '50',
    heartbeatMs: String(options.heartbeatMs ?? 15_000),
    after: options.after
  })
  if (options.queue !== undefined && options.queue.length > 0) query.set('queue', options.queue)
  if (options.type !== undefined && options.type.length > 0) query.set('type', options.type)
  return `/api/events/stream?${query}`
}
