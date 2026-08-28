import type { RuntimeObserver as RuntimeObserverContract } from 'better-effect'
import {
  RecordedRuntimeObserver,
  RuntimeObserver,
  type RecordedRuntimeObserverSnapshot,
  type RuntimeObserverEvent
} from 'better-effect/testing'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false

type Expect<Value extends true> = Value

const recorder = RecordedRuntimeObserver.make()
const composed: RuntimeObserverContract = RuntimeObserver.compose(recorder)
const snapshot = recorder.snapshot()

export type RecorderIsRuntimeObserver = Expect<
  Equal<RecordedRuntimeObserver extends RuntimeObserverContract ? true : false, true>
>
export type TimelineIsReadonly = Expect<
  Equal<RecordedRuntimeObserverSnapshot['timeline'], readonly RuntimeObserverEvent[]>
>

void composed
void snapshot
