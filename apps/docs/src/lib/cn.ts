export { cn } from 'cnfast'

export const resolveClassName = <State>(
  className: string | ((state: State) => string | undefined) | undefined,
  state: State
) => (className instanceof Function ? className(state) : className)
