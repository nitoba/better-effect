import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  CircleSlash2,
  Clock3,
  Database,
  Gauge,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  Workflow,
  XCircle
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { StatusBadge } from '@/components/status-badge'
import {
  apiUrl,
  formatDuration,
  formatTimestamp,
  requestJson,
  type Attempt,
  type DashboardTab,
  type DurableEvent,
  type FlowSnapshot,
  type Job,
  type JobState,
  type Overview,
  type QueueControl,
  type Schedule
} from '@/lib/dashboard-api'

const MAX_EVENT_BUFFER = 200
const jobStates: readonly JobState[] = [
  'waiting',
  'delayed',
  'active',
  'completed',
  'failed',
  'cancelled'
]
type IconComponent = typeof Activity

function ErrorNotice({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
        <AlertTriangle className="size-4 shrink-0" />
        <span className="flex-1">{error}</span>
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Tentar novamente
          </Button>
        ) : null}
      </CardContent>
    </Card>
  )
}

function MetricCard({
  label,
  value,
  icon: Icon,
  tone = 'default'
}: {
  label: string
  value: number | string
  icon: IconComponent
  tone?: 'default' | 'positive' | 'warning' | 'danger'
}) {
  const toneClass = {
    default: 'bg-primary/10 text-primary',
    positive: 'bg-emerald-500/10 text-emerald-600',
    warning: 'bg-amber-500/10 text-amber-600',
    danger: 'bg-red-500/10 text-red-600'
  }[tone]

  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className={`flex size-10 items-center justify-center rounded-xl ${toneClass}`}>
          <Icon className="size-5" />
        </div>
        <div>
          <div className="text-2xl font-semibold tracking-tight">{value}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  )
}

function CapabilityBadge({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <Badge variant={enabled ? 'secondary' : 'outline'} className="gap-1.5">
      {enabled ? (
        <CheckCircle2 className="size-3.5 text-emerald-600" />
      ) : (
        <CircleSlash2 className="size-3.5" />
      )}
      {label}
    </Badge>
  )
}

function LoadingCards() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }, (_, index) => (
        <Card key={index}>
          <CardContent className="space-y-3 p-5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-16" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function OverviewPanel({ overview, onRefresh }: { overview: Overview; onRefresh: () => void }) {
  const total = overview.counts.total ?? 0
  const active = overview.counts.active ?? 0
  const failed = overview.counts.failed ?? 0
  const completed = overview.counts.completed ?? 0

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">Visão operacional</p>
          <h2 className="text-2xl font-semibold tracking-tight">Fila em tempo real</h2>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCw className="size-4" />
          Atualizar
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Jobs no store" value={total} icon={Database} />
        <MetricCard label="Em execução" value={active} icon={Activity} tone="positive" />
        <MetricCard label="Concluídos" value={completed} icon={CheckCircle2} tone="positive" />
        <MetricCard label="Falhos" value={failed} icon={AlertTriangle} tone="danger" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Estado do store</CardTitle>
            <CardDescription>
              {overview.store.adapter} · protocolo {overview.store.protocolVersion} · layout{' '}
              {overview.store.layoutVersion}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {Object.entries(overview.counts)
              .filter(([key]) => key !== 'total')
              .map(([state, count]) => (
                <div
                  key={state}
                  className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2 text-sm"
                >
                  <StatusBadge state={state} />
                  <span className="font-medium">{count}</span>
                </div>
              ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Capacidades</CardTitle>
            <CardDescription>Extensões instaladas neste host.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <CapabilityBadge label="Eventos duráveis" enabled={overview.capabilities.events} />
            <CapabilityBadge label="Schedules" enabled={overview.capabilities.schedules} />
            <CapabilityBadge label="Flows" enabled={overview.capabilities.flows} />
            <CapabilityBadge label="Controls" enabled={overview.capabilities.controls} />
            <CapabilityBadge
              label="Política de mutação"
              enabled={overview.capabilities.security.mutationPolicy}
            />
            <CapabilityBadge label="Auditoria" enabled={overview.capabilities.security.audit} />
            <CapabilityBadge
              label="Rate limit"
              enabled={overview.capabilities.security.rateLimit}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filas pausadas</CardTitle>
          <CardDescription>Controles distribuídos ativos no namespace atual.</CardDescription>
        </CardHeader>
        <CardContent>
          {overview.pausedQueues.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma fila pausada.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {overview.pausedQueues.map((queue) => (
                <Badge key={queue} variant="outline" className="gap-1.5">
                  <Pause className="size-3.5" />
                  {queue}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ConfirmationAction({
  label,
  title,
  description,
  onConfirm,
  variant = 'outline',
  icon: Icon
}: {
  label: string
  title: string
  description: string
  onConfirm: () => Promise<void>
  variant?: 'outline' | 'destructive' | 'default' | 'secondary'
  icon: IconComponent
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const confirm = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await onConfirm()
      setOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'A operação falhou.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setError(undefined)
      }}
    >
      <AlertDialogTrigger
        render={
          <Button variant={variant} size="sm" disabled={busy}>
            <Icon className="size-4" />
            {label}
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={() => void confirm()} disabled={busy}>
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Confirmar
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function JobActions({ job, onChanged }: { job: Job; onChanged: () => Promise<void> }) {
  const mutate = async (path: string, body?: Readonly<Record<string, number>>) => {
    const init: RequestInit = { method: 'POST' }
    if (body !== undefined) init.body = JSON.stringify(body)
    await requestJson(path, init)
    await onChanged()
  }
  const canCancel = job.state === 'waiting' || job.state === 'delayed' || job.state === 'active'
  const canPromote = job.state === 'delayed'
  const canRetry = job.state === 'failed' || job.state === 'cancelled'
  const canRemove = job.state !== 'active'

  return (
    <div className="flex flex-wrap gap-2">
      {canCancel ? (
        <ConfirmationAction
          label="Cancelar"
          title="Cancelar este job?"
          description="A solicitação será persistida no JobStore e não cancela o processo do worker à força."
          icon={XCircle}
          onConfirm={() => mutate(`/api/jobs/${job.id}/cancel`)}
        />
      ) : null}
      {canPromote ? (
        <ConfirmationAction
          label="Promover"
          title="Promover este job agora?"
          description="O job delayed será tornado elegível sem alterar seu payload."
          icon={ArrowDownToLine}
          onConfirm={() => mutate(`/api/jobs/${job.id}/promote`)}
        />
      ) : null}
      {canRetry ? (
        <ConfirmationAction
          label="Retry"
          title="Reagendar este job?"
          description="O job será reencaminhado imediatamente com uma nova janela de tentativas."
          icon={RotateCcw}
          onConfirm={() => mutate(`/api/jobs/${job.id}/retry`, { delayMs: 0 })}
        />
      ) : null}
      {canRetry ? (
        <ConfirmationAction
          label="Redrive"
          title="Redrive este job?"
          description="Redrive usa a mesma operação durável de retry para este dashboard."
          icon={Play}
          onConfirm={() => mutate(`/api/jobs/${job.id}/redrive`, { delayMs: 0 })}
        />
      ) : null}
      {canRemove ? (
        <ConfirmationAction
          label="Remover"
          title="Remover este job?"
          description="A remoção é uma operação administrativa permanente no JobStore."
          icon={Trash2}
          variant="destructive"
          onConfirm={async () => {
            await requestJson(`/api/jobs/${job.id}`, { method: 'DELETE' })
            await onChanged()
          }}
        />
      ) : null}
    </div>
  )
}

function JobDetail({
  job,
  attempts,
  onChanged
}: {
  job: Job | undefined
  attempts: readonly Attempt[]
  onChanged: () => Promise<void>
}) {
  if (job === undefined) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex min-h-48 items-center justify-center p-6 text-sm text-muted-foreground">
          Selecione um job para inspecionar detalhes e operações.
        </CardContent>
      </Card>
    )
  }

  const fields: readonly [string, string | number][] = [
    ['Fila', job.queue],
    ['Versão', job.version],
    ['Prioridade', job.priority],
    ['Tentativas', `${job.attemptsMade}/${job.attemptsMax}`],
    ['Deliveries', job.deliveryCount],
    ['Stalled', job.stalledCount],
    ['Agendado', formatTimestamp(job.runAt)],
    ['Atualizado', formatTimestamp(job.updatedAt)]
  ]

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              {job.name}
              <StatusBadge state={job.state} />
            </CardTitle>
            <CardDescription className="mt-1 font-mono text-xs">{job.id}</CardDescription>
          </div>
          <JobActions job={job} onChanged={onChanged} />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {fields.map(([label, value]) => (
            <div key={label} className="rounded-lg border bg-muted/20 px-3 py-2">
              <div className="text-[11px] text-muted-foreground">{label}</div>
              <div className="mt-1 truncate text-sm font-medium">{value}</div>
            </div>
          ))}
        </div>
        <Separator />
        <div>
          <div className="mb-3 flex items-center gap-2 text-sm font-medium">
            <Clock3 className="size-4 text-muted-foreground" />
            Attempt ledger
          </div>
          {attempts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma tentativa registrada.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Attempt</TableHead>
                  <TableHead>Delivery</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Início</TableHead>
                  <TableHead>Fim</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {attempts.map((attempt) => (
                  <TableRow key={`${attempt.attemptSequence}-${attempt.delivery}`}>
                    <TableCell>{attempt.attempt}</TableCell>
                    <TableCell>{attempt.delivery}</TableCell>
                    <TableCell>{attempt.outcome ?? '—'}</TableCell>
                    <TableCell>{formatTimestamp(attempt.startedAt)}</TableCell>
                    <TableCell>{formatTimestamp(attempt.finishedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function JobsPanel({
  overview,
  onRefresh
}: {
  overview: Overview | undefined
  onRefresh: () => Promise<void>
}) {
  const [queue, setQueue] = useState('')
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [metadata, setMetadata] = useState('')
  const [state, setState] = useState('all')
  const [jobs, setJobs] = useState<readonly Job[]>([])
  const [selectedJob, setSelectedJob] = useState<Job | undefined>()
  const [attempts, setAttempts] = useState<readonly Attempt[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()

  const loadJobs = useCallback(
    async (nextCursor?: string) => {
      setLoading(true)
      setError(undefined)
      const query = new URLSearchParams({ limit: '50' })
      if (queue.trim()) query.set('queue', queue.trim())
      if (name.trim()) query.set('name', name.trim())
      if (version.trim()) query.set('version', version.trim())
      if (metadata.trim()) query.set('metadata', metadata.trim())
      if (state !== 'all') query.set('state', state)
      if (nextCursor) query.set('cursor', nextCursor)
      try {
        const result = await requestJson<{
          jobs: readonly Job[]
          nextCursor: string | undefined
        }>(`/api/jobs?${query}`)
        setJobs(result.jobs)
        setCursor(result.nextCursor)
        setSelectedJob((current) => {
          if (current === undefined) return current
          return result.jobs.find((job) => job.id === current.id) ?? current
        })
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Não foi possível carregar os jobs.')
      } finally {
        setLoading(false)
      }
    },
    [metadata, name, queue, state, version]
  )

  const loadAttempts = useCallback(async (job: Job | undefined) => {
    if (job === undefined) {
      setAttempts([])
      return
    }
    try {
      const result = await requestJson<{ attempts: readonly Attempt[] }>(
        `/api/jobs/${job.id}/attempts`
      )
      setAttempts(result.attempts)
    } catch {
      setAttempts([])
    }
  }, [])

  useEffect(() => {
    void loadJobs()
  }, [loadJobs])
  useEffect(() => {
    void loadAttempts(selectedJob)
  }, [loadAttempts, selectedJob])

  const refreshSelectedJob = async () => {
    await loadJobs()
    await onRefresh()
    await loadAttempts(selectedJob)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">Administração</p>
          <h2 className="text-2xl font-semibold tracking-tight">Jobs</h2>
        </div>
        <Button variant="outline" size="sm" onClick={() => void loadJobs()}>
          <RefreshCw className="size-4" />
          Atualizar jobs
        </Button>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Filtrar por fila"
              className="pl-9"
              placeholder="Fila"
              value={queue}
              onChange={(event) => setQueue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void loadJobs()
              }}
            />
          </div>
          <Input
            aria-label="Filtrar por nome"
            className="lg:max-w-52"
            placeholder="Nome do job"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void loadJobs()
            }}
          />
          <Input
            aria-label="Filtrar por versão"
            className="lg:max-w-32"
            inputMode="numeric"
            placeholder="Versão"
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void loadJobs()
            }}
          />
          <Input
            aria-label="Filtrar por metadata segura"
            className="lg:max-w-52"
            placeholder="chave:valor"
            value={metadata}
            onChange={(event) => setMetadata(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void loadJobs()
            }}
          />
          <Select value={state} onValueChange={(value) => setState(value ?? 'all')}>
            <SelectTrigger aria-label="Filtrar por estado" className="w-full lg:w-44">
              <SelectValue placeholder="Estado" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os estados</SelectItem>
              {jobStates.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => void loadJobs()}>
            <Search className="size-4" />
            Filtrar
          </Button>
        </CardContent>
      </Card>
      {error ? <ErrorNotice error={error} onRetry={() => void loadJobs()} /> : null}
      <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-base">Resultados</CardTitle>
            <CardDescription>
              {loading ? 'Carregando...' : `${jobs.length} jobs nesta página`}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job</TableHead>
                    <TableHead>Fila</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Atualizado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={4}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {!loading && jobs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                        Nenhum job encontrado.
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {jobs.map((job) => (
                    <TableRow
                      key={job.id}
                      data-state={selectedJob?.id === job.id ? 'selected' : undefined}
                      className="cursor-pointer"
                      tabIndex={0}
                      aria-selected={selectedJob?.id === job.id}
                      onClick={() => setSelectedJob(job)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          setSelectedJob(job)
                        }
                      }}
                    >
                      <TableCell>
                        <div className="font-medium">{job.name}</div>
                        <div className="max-w-44 truncate font-mono text-[11px] text-muted-foreground">
                          {job.id}
                        </div>
                      </TableCell>
                      <TableCell>{job.queue}</TableCell>
                      <TableCell>
                        <StatusBadge state={job.state} />
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                        {formatTimestamp(job.updatedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {cursor ? (
              <div className="flex justify-end border-t p-3">
                <Button variant="outline" size="sm" onClick={() => void loadJobs(cursor)}>
                  Próxima página
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
        <JobDetail job={selectedJob} attempts={attempts} onChanged={refreshSelectedJob} />
      </div>
      {overview?.capabilities.security.mutationPolicy === false ? (
        <p className="text-xs text-muted-foreground">
          Mutações estão bloqueadas: o host não forneceu uma política de confirmação/CSRF.
        </p>
      ) : null}
    </div>
  )
}

function EventTail() {
  const [events, setEvents] = useState<readonly DurableEvent[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const cursorRef = useRef<string | undefined>(undefined)
  const [queue, setQueue] = useState('')
  const [type, setType] = useState('all')
  const [status, setStatus] = useState('Carregando eventos...')
  const [error, setError] = useState<string | undefined>()
  const [dropped, setDropped] = useState(0)
  const [streamGeneration, setStreamGeneration] = useState(0)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const loadPage = useCallback(async () => {
    const query = new URLSearchParams({ limit: '50' })
    if (queue.trim()) query.set('queue', queue.trim())
    if (type !== 'all') query.set('type', type)
    try {
      const result = await requestJson<{
        events: readonly DurableEvent[]
        nextCursor: string | undefined
      }>(`/api/events?${query}`)
      const nextCursor = result.nextCursor ?? result.events.at(-1)?.cursor
      cursorRef.current = nextCursor
      setEvents(result.events)
      setCursor(nextCursor)
      setError(undefined)
      setStatus('Conectando ao live tail…')
      setStreamGeneration((value) => value + 1)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Feed de eventos indisponível.')
      setStatus('Feed indisponível')
    }
  }, [queue, type])

  useEffect(() => {
    void loadPage()
  }, [loadPage])

  useEffect(() => {
    const initialCursor = cursorRef.current
    if (error || initialCursor === undefined) return undefined
    const query = new URLSearchParams({
      limit: '50',
      heartbeatMs: '15000',
      after: initialCursor
    })
    if (queue.trim()) query.set('queue', queue.trim())
    if (type !== 'all') query.set('type', type)
    const source = new EventSource(apiUrl(`/api/events/stream?${query}`), {
      withCredentials: true
    })
    setStatus('Conectado')
    source.addEventListener('job-event', (event) => {
      // SAFETY: EventSource delivers named event payloads as MessageEvent values.
      const message = event as MessageEvent<string>
      // SAFETY: the dashboard backend emits this listener only with sanitized DurableEvent JSON.
      const next = JSON.parse(message.data) as DurableEvent
      cursorRef.current = next.cursor
      setCursor(next.cursor)
      setEvents((current) => {
        const combined = [...current, next]
        const overflow = Math.max(0, combined.length - MAX_EVENT_BUFFER)
        if (overflow > 0) setDropped((count) => count + overflow)
        return combined.slice(-MAX_EVENT_BUFFER)
      })
    })
    source.addEventListener('heartbeat', () => setStatus('Conectado · heartbeat recebido'))
    source.addEventListener('cursor-expired', () => {
      source.close()
      setStatus('Cursor expirado')
      setError(
        'A retenção removeu o cursor atual. Atualize o feed para recomeçar do cursor disponível.'
      )
    })
    source.onerror = () => {
      source.close()
      setStatus('Reconectando…')
      retryTimer.current = setTimeout(() => {
        void loadPage()
      }, 2_000)
    }
    return () => {
      source.close()
      if (retryTimer.current !== undefined) clearTimeout(retryTimer.current)
    }
  }, [error, loadPage, queue, streamGeneration, type])

  const restart = () => {
    cursorRef.current = undefined
    setCursor(undefined)
    setError(undefined)
    setDropped(0)
    void loadPage()
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Live event tail</CardTitle>
            <CardDescription>
              Reconexão por cursor, heartbeat não durável e buffer limitado a {MAX_EVENT_BUFFER}{' '}
              eventos.
            </CardDescription>
          </div>
          <Badge variant="outline" className="gap-1.5">
            <Activity className="size-3.5 text-emerald-600" />
            {status}
          </Badge>
        </div>
        <div className="flex flex-col gap-3 pt-3 sm:flex-row">
          <Input
            aria-label="Filtrar eventos por fila"
            placeholder="Fila"
            value={queue}
            onChange={(event) => setQueue(event.target.value)}
          />
          <Select value={type} onValueChange={(value) => setType(value ?? 'all')}>
            <SelectTrigger aria-label="Filtrar eventos por tipo" className="w-full sm:w-56">
              <SelectValue placeholder="Tipo de evento" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os tipos</SelectItem>
              <SelectItem value="job-enqueued">job-enqueued</SelectItem>
              <SelectItem value="job-completed">job-completed</SelectItem>
              <SelectItem value="job-failed">job-failed</SelectItem>
              <SelectItem value="job-cancelled">job-cancelled</SelectItem>
              <SelectItem value="job-promoted">job-promoted</SelectItem>
              <SelectItem value="job-retry-scheduled">job-retry-scheduled</SelectItem>
              <SelectItem value="job-stalled-recovered">job-stalled-recovered</SelectItem>
              <SelectItem value="job-removed">job-removed</SelectItem>
              <SelectItem value="queue-paused">queue-paused</SelectItem>
              <SelectItem value="queue-resumed">queue-resumed</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={restart}>
            <RefreshCw className="size-4" />
            Recomeçar
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error ? <ErrorNotice error={error} onRetry={restart} /> : null}
        <ScrollArea className="h-[28rem] rounded-lg border">
          <div className="divide-y">
            {events.length === 0 && !error ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                Aguardando eventos…
              </div>
            ) : null}
            {events.map((event) => (
              <div
                key={`${event.cursor}-${event.type}`}
                className="grid gap-2 p-3 text-sm md:grid-cols-[auto_1fr_auto] md:items-center"
              >
                <Badge variant="secondary" className="w-fit font-mono text-[11px]">
                  {event.type}
                </Badge>
                <div className="min-w-0">
                  <div className="truncate font-medium">{event.jobId ?? 'evento sem job'}</div>
                  <div className="text-xs text-muted-foreground">
                    {event.queue ?? '—'} · {event.outcome ?? event.state ?? 'transição'}
                  </div>
                </div>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {event.cursor}
                      </span>
                    }
                  />
                  <TooltipContent>{formatTimestamp(event.recordedAtMs)}</TooltipContent>
                </Tooltip>
              </div>
            ))}
          </div>
        </ScrollArea>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            Cursor atual: <span className="font-mono">{cursor ?? '—'}</span>
          </span>
          {dropped > 0 ? <span>{dropped} eventos antigos removidos do buffer local.</span> : null}
        </div>
      </CardContent>
    </Card>
  )
}

function ExtensionsPanel({ overview }: { overview: Overview | undefined }) {
  const [schedules, setSchedules] = useState<readonly Schedule[]>([])
  const [control, setControl] = useState<QueueControl | undefined>()
  const [flow, setFlow] = useState<FlowSnapshot | undefined>()
  const [queue, setQueue] = useState(overview?.pausedQueues[0] ?? '')
  const [pausedQueues, setPausedQueues] = useState<readonly string[]>(overview?.pausedQueues ?? [])
  const [flowId, setFlowId] = useState('')
  const [message, setMessage] = useState<string | undefined>()

  const loadSchedules = useCallback(async () => {
    try {
      setSchedules(
        (await requestJson<{ schedules: readonly Schedule[] }>('/api/schedules?limit=50')).schedules
      )
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Schedules indisponíveis.')
    }
  }, [])
  const loadControl = useCallback(async () => {
    if (!queue.trim()) return
    try {
      setMessage(undefined)
      setControl(
        await requestJson<QueueControl>(`/api/controls/${encodeURIComponent(queue.trim())}`)
      )
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Control indisponível.')
    }
  }, [queue])
  const loadFlow = useCallback(async () => {
    if (!flowId.trim()) return
    try {
      setMessage(undefined)
      setFlow(await requestJson<FlowSnapshot>(`/api/flows/${encodeURIComponent(flowId.trim())}`))
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Flow indisponível.')
    }
  }, [flowId])

  const scheduleMutation = async (schedule: Schedule, action: 'pause' | 'resume' | 'remove') => {
    try {
      setMessage(undefined)
      await requestJson(
        `/api/schedules/${encodeURIComponent(schedule.group)}/${encodeURIComponent(schedule.key)}${action === 'remove' ? '' : `/${action}`}`,
        { method: action === 'remove' ? 'DELETE' : 'POST' }
      )
      await loadSchedules()
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'A operação do schedule falhou.')
      throw caught
    }
  }

  const queueMutation = async (action: 'pause' | 'resume') => {
    if (!control) return
    try {
      setMessage(undefined)
      await requestJson(`/api/queues/${encodeURIComponent(control.queue)}/${action}`, {
        method: 'POST'
      })
      setPausedQueues((current) => {
        const next = new Set(current)
        if (action === 'pause') next.add(control.queue)
        else next.delete(control.queue)
        return [...next]
      })
      await loadControl()
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'A operação da fila falhou.')
      throw caught
    }
  }

  const cancelFlow = async () => {
    if (!flowId.trim()) return
    try {
      setMessage(undefined)
      await requestJson(`/api/flows/${encodeURIComponent(flowId.trim())}/cancel`, {
        method: 'POST'
      })
      await loadFlow()
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'O cancelamento do flow falhou.')
      throw caught
    }
  }

  useEffect(() => {
    if (overview?.capabilities.schedules) void loadSchedules()
  }, [loadSchedules, overview?.capabilities.schedules])
  useEffect(() => {
    setPausedQueues(overview?.pausedQueues ?? [])
  }, [overview?.pausedQueues])

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">Extensões opcionais</p>
        <h2 className="text-2xl font-semibold tracking-tight">Schedules, flows e controls</h2>
      </div>
      {message ? <ErrorNotice error={message} onRetry={() => setMessage(undefined)} /> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className={!overview?.capabilities.schedules ? 'opacity-60' : undefined}>
          <CardHeader>
            <CardTitle className="text-base">Schedules</CardTitle>
            <CardDescription>Definições registradas no store.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {overview?.capabilities.schedules ? (
              <>
                <Button size="sm" variant="outline" onClick={() => void loadSchedules()}>
                  <RefreshCw className="size-4" />
                  Carregar
                </Button>
                {schedules.map((schedule) => (
                  <div
                    key={`${schedule.group}/${schedule.key}`}
                    className="rounded-lg border p-3 text-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {schedule.group}/{schedule.key}
                      </span>
                      <Badge variant={schedule.paused ? 'outline' : 'secondary'}>
                        {schedule.paused ? 'pausado' : 'ativo'}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {schedule.cron ?? `a cada ${formatDuration(schedule.everyMs)}`} · próximo{' '}
                      {formatTimestamp(schedule.nextRunAtMs)}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {schedule.paused ? (
                        <ConfirmationAction
                          label="Retomar"
                          title="Retomar este schedule?"
                          description="Novas execuções voltarão a ser agendadas para este schedule."
                          icon={Play}
                          onConfirm={() => scheduleMutation(schedule, 'resume')}
                        />
                      ) : (
                        <ConfirmationAction
                          label="Pausar"
                          title="Pausar este schedule?"
                          description="O schedule permanecerá registrado, mas não criará novas execuções enquanto estiver pausado."
                          icon={Pause}
                          onConfirm={() => scheduleMutation(schedule, 'pause')}
                        />
                      )}
                      <ConfirmationAction
                        label="Remover"
                        title="Remover este schedule?"
                        description="A remoção é administrativa e não pode ser desfeita pelo dashboard."
                        variant="destructive"
                        icon={Trash2}
                        onConfirm={() => scheduleMutation(schedule, 'remove')}
                      />
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Extensão não instalada.</p>
            )}
          </CardContent>
        </Card>
        <Card className={!overview?.capabilities.flows ? 'opacity-60' : undefined}>
          <CardHeader>
            <CardTitle className="text-base">Flow snapshot</CardTitle>
            <CardDescription>Inspecione um flow por ID.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {overview?.capabilities.flows ? (
              <>
                <div className="flex gap-2">
                  <Input
                    aria-label="ID do flow"
                    placeholder="Flow ID"
                    value={flowId}
                    onChange={(event) => setFlowId(event.target.value)}
                  />
                  <Button size="sm" onClick={() => void loadFlow()}>
                    <Search className="size-4" />
                    Abrir
                  </Button>
                </div>
                {flow ? (
                  <div className="space-y-2 rounded-lg border p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{flow.parent.flowName}</span>
                      <Badge variant="outline">{flow.parent.state}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {flow.children.length} children · {flow.outbox.length} outbox
                    </div>
                    {!['completed', 'failed', 'cancelled'].includes(flow.parent.state) ? (
                      <div className="pt-1">
                        <ConfirmationAction
                          label="Cancelar flow"
                          title="Cancelar este flow?"
                          description="A solicitação será encaminhada ao FlowStore e os registros permanecerão disponíveis para auditoria."
                          icon={XCircle}
                          onConfirm={cancelFlow}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Extensão não instalada.</p>
            )}
          </CardContent>
        </Card>
        <Card className={!overview?.capabilities.controls ? 'opacity-60' : undefined}>
          <CardHeader>
            <CardTitle className="text-base">Queue controls</CardTitle>
            <CardDescription>Estado distribuído por fila.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {overview?.capabilities.controls ? (
              <>
                <div className="flex gap-2">
                  <Input
                    aria-label="Nome da fila"
                    placeholder="Queue"
                    value={queue}
                    onChange={(event) => setQueue(event.target.value)}
                  />
                  <Button size="sm" onClick={() => void loadControl()}>
                    <Search className="size-4" />
                    Abrir
                  </Button>
                </div>
                {control ? (
                  <div className="space-y-2 rounded-lg border p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{control.queue}</span>
                      <Badge variant={control.enabled ? 'secondary' : 'outline'}>
                        {control.enabled ? 'enabled' : 'disabled'}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      global {control.globalConcurrency ?? '—'} · key{' '}
                      {control.perKeyConcurrency ?? '—'}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <Badge
                        variant={pausedQueues.includes(control.queue) ? 'outline' : 'secondary'}
                      >
                        {pausedQueues.includes(control.queue) ? 'fila pausada' : 'fila ativa'}
                      </Badge>
                      {pausedQueues.includes(control.queue) ? (
                        <ConfirmationAction
                          label="Retomar fila"
                          title="Retomar esta fila?"
                          description="Novos jobs voltarão a ser elegíveis para esta fila."
                          icon={Play}
                          onConfirm={() => queueMutation('resume')}
                        />
                      ) : (
                        <ConfirmationAction
                          label="Pausar fila"
                          title="Pausar esta fila?"
                          description="Jobs existentes permanecem duráveis, mas a fila deixa de admitir novos processamentos até ser retomada."
                          icon={Pause}
                          onConfirm={() => queueMutation('pause')}
                        />
                      )}
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Extensão não instalada.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function HealthPanel({ overview }: { overview: Overview | undefined }) {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">Diagnóstico</p>
        <h2 className="text-2xl font-semibold tracking-tight">Health do dashboard</h2>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-emerald-600" />
            Host e segurança
          </CardTitle>
          <CardDescription>
            O frontend não carrega credenciais; autenticação e política são fornecidas pelo host.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <CapabilityBadge label="Dashboard online" enabled={overview !== undefined} />
          <CapabilityBadge label="Eventos" enabled={overview?.capabilities.events === true} />
          <CapabilityBadge
            label="Policy"
            enabled={overview?.capabilities.security.mutationPolicy === true}
          />
          <CapabilityBadge
            label="Rate limit"
            enabled={overview?.capabilities.security.rateLimit === true}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Descriptor do store</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {overview ? (
            <>
              {[
                ['Adapter', overview.store.adapter],
                ['Versão', overview.store.adapterVersion],
                ['Protocol', overview.store.protocolVersion],
                ['Layout', overview.store.layoutVersion]
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border bg-muted/20 p-3">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="mt-1 font-mono text-sm">{value}</div>
                </div>
              ))}
            </>
          ) : (
            <Skeleton className="h-16 w-full" />
          )}
        </CardContent>
      </Card>
      <Card className="border-dashed">
        <CardContent className="flex items-start gap-3 p-5 text-sm text-muted-foreground">
          <Gauge className="mt-0.5 size-4 shrink-0" />
          <span>
            Falhas de lease, stalled recovery, lag de consumidores e status de notificações ainda
            dependem de uma extensão de health no backend. Esta tela expõe o descriptor e as
            capacidades públicas sem inventar métricas.
          </span>
        </CardContent>
      </Card>
    </div>
  )
}

export function App() {
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview')
  const [overview, setOverview] = useState<Overview | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()

  const loadOverview = useCallback(async () => {
    try {
      setLoading(true)
      setError(undefined)
      setOverview(await requestJson<Overview>('/api/overview'))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível conectar ao dashboard.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  return (
    <TooltipProvider>
      <div className="min-h-svh bg-muted/20">
        <header className="border-b bg-background/90 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 lg:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <Workflow className="size-5" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">better-effect-mq</div>
                <div className="text-xs text-muted-foreground">Reference dashboard</div>
              </div>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Atualizar visão geral"
                    onClick={() => void loadOverview()}
                  >
                    <RefreshCw className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>Atualizar</TooltipContent>
            </Tooltip>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 lg:px-8">
          {error ? (
            <div className="mb-6">
              <ErrorNotice error={error} onRetry={() => void loadOverview()} />
            </div>
          ) : null}
          {loading && overview === undefined ? (
            <LoadingCards />
          ) : (
            <Tabs
              value={activeTab}
              onValueChange={(value) => {
                switch (value) {
                  case 'overview':
                  case 'jobs':
                  case 'events':
                  case 'extensions':
                  case 'health':
                    setActiveTab(value)
                    break
                }
              }}
            >
              <TabsList
                variant="line"
                className="mb-6 w-full justify-start overflow-x-auto sm:w-fit"
              >
                <TabsTrigger value="overview">
                  <Gauge className="size-4" />
                  Overview
                </TabsTrigger>
                <TabsTrigger value="jobs">
                  <Database className="size-4" />
                  Jobs
                </TabsTrigger>
                <TabsTrigger value="events">
                  <Activity className="size-4" />
                  Events
                </TabsTrigger>
                <TabsTrigger value="extensions">
                  <Workflow className="size-4" />
                  Extensions
                </TabsTrigger>
                <TabsTrigger value="health">
                  <ShieldCheck className="size-4" />
                  Health
                </TabsTrigger>
              </TabsList>
              <TabsContent value="overview">
                {overview ? (
                  <OverviewPanel overview={overview} onRefresh={() => void loadOverview()} />
                ) : null}
              </TabsContent>
              <TabsContent value="jobs">
                <JobsPanel overview={overview} onRefresh={loadOverview} />
              </TabsContent>
              <TabsContent value="events">
                {overview?.capabilities.events ? (
                  <EventTail />
                ) : (
                  <Card className="border-dashed">
                    <CardContent className="flex min-h-40 items-center justify-center p-6 text-sm text-muted-foreground">
                      Event Store não está instalado neste host.
                    </CardContent>
                  </Card>
                )}
              </TabsContent>
              <TabsContent value="extensions">
                <ExtensionsPanel overview={overview} />
              </TabsContent>
              <TabsContent value="health">
                <HealthPanel overview={overview} />
              </TabsContent>
            </Tabs>
          )}
        </main>
        <footer className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 pb-6 text-xs text-muted-foreground lg:px-8">
          <span>Dados sanitizados pelo backend público do dashboard.</span>
          <span>Sem credenciais no bundle do cliente.</span>
        </footer>
      </div>
    </TooltipProvider>
  )
}

export default App
