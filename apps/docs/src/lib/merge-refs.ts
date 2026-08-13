import type * as React from 'react'

export function mergeRefs<T>(...refs: (React.Ref<T> | undefined)[]): React.RefCallback<T> {
  return (value) => {
    refs.forEach((ref) => {
      if (ref && 'current' in ref) {
        ref.current = value
      } else if (ref) {
        ref(value)
      }
    })
  }
}
