import { Badge } from '@/components/ui/badge'
import { cn } from 'cn'
import type { JobState } from '@/lib/dashboard-api'

const stateClasses = {
  waiting:
    'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300',
  delayed:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  active:
    'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-300',
  completed:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  failed:
    'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300',
  cancelled:
    'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
} satisfies Record<JobState, string>

function isJobState(value: string): value is JobState {
  return Object.hasOwn(stateClasses, value)
}

export function StatusBadge({ state }: { state: string }) {
  const label = state.replaceAll('-', ' ')
  return (
    <Badge
      aria-label={`Estado: ${label}`}
      variant="outline"
      className={cn(
        'capitalize',
        isJobState(state) ? stateClasses[state] : 'border-border bg-muted text-muted-foreground'
      )}
    >
      {label}
    </Badge>
  )
}
