import { Badge } from '@campfirein/byterover-packages/components/badge'
import { Button } from '@campfirein/byterover-packages/components/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@campfirein/byterover-packages/components/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@campfirein/byterover-packages/components/dialog'
import { Input } from '@campfirein/byterover-packages/components/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@campfirein/byterover-packages/components/table'
import {useDeferredValue, useEffect, useState} from 'react'

import type {HubProgressEvent} from '../../../../shared/transport/events'
import type {AuthScheme} from '../../../../shared/transport/types/auth-scheme'

import {HubEvents} from '../../../../shared/transport/events'
import {AGENT_VALUES} from '../../../../shared/types/agent'
import {useTransportStore} from '../../../stores/transport-store'
import {useAddHubRegistry} from '../api/add-hub-registry'
import {useGetHubEntries} from '../api/get-hub-entries'
import {useInstallHubEntry} from '../api/install-hub-entry'
import {useGetHubRegistries} from '../api/list-hub-registries'
import {useRemoveHubRegistry} from '../api/remove-hub-registry'

type Feedback = {
  details?: string
  text: string
  tone: 'error' | 'info' | 'success' | 'warning'
}

const authSchemeOptions: AuthScheme[] = ['none', 'bearer', 'token', 'basic', 'custom-header']

export function HubPanel() {
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [agentSelections, setAgentSelections] = useState<Record<string, string>>({})
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [progressMessages, setProgressMessages] = useState<string[]>([])
  const [registryToRemove, setRegistryToRemove] = useState<null | string>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [authScheme, setAuthScheme] = useState<AuthScheme>('none')
  const [headerName, setHeaderName] = useState('')
  const [token, setToken] = useState('')

  const apiClient = useTransportStore((state) => state.apiClient)
  const entriesQuery = useGetHubEntries()
  const registriesQuery = useGetHubRegistries()
  const installMutation = useInstallHubEntry()
  const addRegistryMutation = useAddHubRegistry()
  const removeRegistryMutation = useRemoveHubRegistry()

  useEffect(() => {
    if (!apiClient || !entriesQuery.isLoading) return
    setProgressMessages([])
    const unsubscribe = apiClient.on<HubProgressEvent>(HubEvents.LIST_PROGRESS, (data) => {
      setProgressMessages((current) => [...current, data.message])
    })
    return unsubscribe
  }, [apiClient, entriesQuery.isLoading])

  useEffect(() => {
    if (!apiClient || !registriesQuery.isLoading) return
    const unsubscribe = apiClient.on<HubProgressEvent>(HubEvents.REGISTRY_LIST_PROGRESS, (data) => {
      setProgressMessages((current) => [...current, data.message])
    })
    return unsubscribe
  }, [apiClient, registriesQuery.isLoading])

  useEffect(() => {
    if (!apiClient || !addRegistryMutation.isPending) return
    const unsubscribe = apiClient.on<HubProgressEvent>(HubEvents.REGISTRY_ADD_PROGRESS, (data) => {
      setProgressMessages((current) => [...current, data.message])
    })
    return unsubscribe
  }, [addRegistryMutation.isPending, apiClient])

  const filteredEntries = (entriesQuery.data?.entries ?? []).filter((entry) => {
    const haystack = [
      entry.name,
      entry.description,
      entry.category,
      entry.type,
      ...(entry.tags ?? []),
      ...(entry.metadata?.use_cases ?? []),
    ]
      .join(' ')
      .toLowerCase()

    return haystack.includes(deferredSearch.trim().toLowerCase())
  })

  async function handleInstallEntry(entryId: string, registry?: string, type?: string) {
    try {
      const agent = type === 'agent-skill' ? agentSelections[entryId] ?? 'Codex' : undefined
      // Omit scope so the daemon infers the per-agent default (global for
      // global-only skill agents like Hermes/OpenClaw, project otherwise).
      const result = await installMutation.mutateAsync({agent, entryId, registry})
      setFeedback({
        details: result.installedPath ? `Installed at ${result.installedPath}` : result.installedFiles.join('\n'),
        text: result.message,
        tone: 'success',
      })
    } catch (installError) {
      setFeedback({
        text: installError instanceof Error ? installError.message : 'Hub install failed',
        tone: 'error',
      })
    }
  }

  async function handleAddRegistry() {
    if (!name.trim() || !url.trim()) {
      setFeedback({text: 'Registry name and URL are required.', tone: 'warning'})
      return
    }

    try {
      const result = await addRegistryMutation.mutateAsync({
        authScheme,
        headerName: authScheme === 'custom-header' ? headerName.trim() : undefined,
        name: name.trim(),
        token: authScheme === 'none' ? undefined : token.trim() || undefined,
        url: url.trim(),
      })
      setFeedback({text: result.message, tone: 'success'})
      setName('')
      setUrl('')
      setHeaderName('')
      setToken('')
    } catch (addError) {
      setFeedback({
        text: addError instanceof Error ? addError.message : 'Failed to add registry',
        tone: 'error',
      })
    }
  }

  async function handleRemoveRegistry() {
    if (!registryToRemove) return

    try {
      const result = await removeRegistryMutation.mutateAsync({name: registryToRemove})
      setFeedback({text: result.message, tone: 'success'})
      setRegistryToRemove(null)
    } catch (removeError) {
      setFeedback({
        text: removeError instanceof Error ? removeError.message : 'Failed to remove registry',
        tone: 'error',
      })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="shadow-sm ring-border/70" size="sm">
        <CardHeader>
          <div>
            <CardTitle className="font-semibold">Hub catalog</CardTitle>
            <CardDescription>Search registry entries, then install them into the current project scope.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-semibold text-muted-foreground" htmlFor="hub-search">
              Search entries
            </label>
            <Input
              className="h-10 rounded-lg bg-background px-3"
              id="hub-search"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name, tag, use case, or category"
              value={search}
            />
          </div>

          {feedback ? <div className={feedback.tone === 'error' ? 'p-4 border border-destructive/20 rounded-xl bg-destructive/5 text-destructive' : feedback.tone === 'info' ? 'p-4 border border-blue-500/20 rounded-xl bg-blue-50 text-blue-700' : feedback.tone === 'success' ? 'p-4 border border-primary/20 rounded-xl bg-primary/5 text-primary' : 'p-4 border border-yellow-500/20 rounded-xl bg-yellow-50 text-yellow-700'}>{feedback.text}</div> : null}
          {feedback?.details ? <pre className="overflow-auto p-4 border border-border rounded-xl bg-foreground text-background whitespace-pre-wrap font-mono text-sm">{feedback.details}</pre> : null}

          {progressMessages.length > 0 ? (
            <div className="flex flex-col gap-2 mt-3">
              {progressMessages.map((message, index) => (
                <div className="text-muted-foreground text-sm" key={`${message}-${index}`}>
                  {message}
                </div>
              ))}
            </div>
          ) : null}

          {entriesQuery.error ? <div className="p-4 border border-destructive/20 rounded-xl bg-destructive/5 text-destructive">{entriesQuery.error.message}</div> : null}
          {registriesQuery.error ? <div className="p-4 border border-destructive/20 rounded-xl bg-destructive/5 text-destructive">{registriesQuery.error.message}</div> : null}
        </CardContent>
      </Card>

      <section className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(17rem,1fr))]">
        {filteredEntries.map((entry) => (
          <Card className="gap-3 px-4 shadow-none ring-border/80" key={`${entry.registry ?? 'default'}:${entry.id}`} size="sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="font-semibold">{entry.name}</CardTitle>
                <CardDescription>{entry.description}</CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge className="rounded-sm border-blue-500/20 bg-blue-500/10 text-blue-600" variant="outline">{entry.type}</Badge>
                <Badge className="rounded-sm border-yellow-500/20 bg-yellow-500/10 text-yellow-600" variant="outline">{entry.category}</Badge>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Card className="gap-1 rounded-lg bg-card px-3 py-3 shadow-none ring-border/80" size="sm">
                <div className="text-xs tracking-wider uppercase text-muted-foreground">Version</div>
                <div className="break-words">{entry.version}</div>
              </Card>
              <Card className="gap-1 rounded-lg bg-card px-3 py-3 shadow-none ring-border/80" size="sm">
                <div className="text-xs tracking-wider uppercase text-muted-foreground">Registry</div>
                <div className="break-words">{entry.registry ?? 'default'}</div>
              </Card>
            </div>

            {entry.type === 'agent-skill' ? (
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-semibold text-muted-foreground" htmlFor={`agent-${entry.id}`}>
                  Target agent
                </label>
                <select
                  className="w-full h-10 px-3 border border-input rounded-lg bg-background text-foreground focus:outline-2 focus:outline-ring/50 focus:outline-offset-2"
                  id={`agent-${entry.id}`}
                  onChange={(event) =>
                    setAgentSelections((current) => ({...current, [entry.id]: event.target.value}))
                  }
                  value={agentSelections[entry.id] ?? 'Codex'}
                >
                  {AGENT_VALUES.map((agent) => (
                    <option key={agent} value={agent}>
                      {agent}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2.5">
              <Button
                className="cursor-pointer" disabled={installMutation.isPending}
                onClick={() => handleInstallEntry(entry.id, entry.registry, entry.type)}
                size="lg"
              >
                {installMutation.isPending ? 'Installing…' : 'Install'}
              </Button>
            </div>

            <div className="text-muted-foreground text-sm">{entry.tags.join(', ')}</div>
          </Card>
        ))}
      </section>

      {filteredEntries.length === 0 && !entriesQuery.isLoading ? (
        <Card className="min-h-56 items-start justify-center gap-3 px-5 shadow-sm ring-border/70" size="sm">
          <Badge className="rounded-sm border-yellow-500/20 bg-yellow-500/10 text-yellow-600" variant="outline">No matches</Badge>
          <CardTitle className="font-semibold">No hub entries matched your search</CardTitle>
          <CardDescription>Try a broader query or add another registry source below.</CardDescription>
        </Card>
      ) : null}

      <div className="grid gap-4 grid-cols-2">
        <Card className="shadow-sm ring-border/70" size="sm">
          <CardHeader>
            <div>
              <CardTitle className="font-semibold">Registry management</CardTitle>
              <CardDescription>Add custom registries and remove ones you no longer want to query.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-semibold text-muted-foreground" htmlFor="registry-name">
                  Registry name
                </label>
                <Input
                  className="h-10 rounded-lg bg-background px-3"
                  id="registry-name"
                  onChange={(event) => setName(event.target.value)}
                  placeholder="team-hub"
                  value={name}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-semibold text-muted-foreground" htmlFor="registry-url">
                  Registry URL
                </label>
                <Input
                  className="h-10 rounded-lg bg-background px-3"
                  id="registry-url"
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://registry.example.com"
                  value={url}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-semibold text-muted-foreground" htmlFor="registry-auth-scheme">
                  Auth scheme
                </label>
                <select
                  className="w-full h-10 px-3 border border-input rounded-lg bg-background text-foreground focus:outline-2 focus:outline-ring/50 focus:outline-offset-2"
                  id="registry-auth-scheme"
                  onChange={(event) => setAuthScheme(event.target.value as AuthScheme)}
                  value={authScheme}
                >
                  {authSchemeOptions.map((scheme) => (
                    <option key={scheme} value={scheme}>
                      {scheme}
                    </option>
                  ))}
                </select>
              </div>

              {authScheme === 'custom-header' ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-semibold text-muted-foreground" htmlFor="registry-header-name">
                    Header name
                  </label>
                  <Input
                    className="h-10 rounded-lg bg-background px-3"
                    id="registry-header-name"
                    onChange={(event) => setHeaderName(event.target.value)}
                    placeholder="X-Registry-Token"
                    value={headerName}
                  />
                </div>
              ) : null}

              {authScheme === 'none' ? null : (
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-semibold text-muted-foreground" htmlFor="registry-token">
                    Token
                  </label>
                  <Input
                    className="h-10 rounded-lg bg-background px-3"
                    id="registry-token"
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="Optional secret for the registry"
                    type="password"
                    value={token}
                  />
                </div>
              )}

              <div className="flex flex-wrap gap-2.5">
                <Button className="cursor-pointer" disabled={addRegistryMutation.isPending} onClick={handleAddRegistry} size="lg">
                  {addRegistryMutation.isPending ? 'Adding…' : 'Add registry'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm ring-border/70" size="sm">
          <CardHeader>
            <div>
              <CardTitle className="font-semibold">Configured registries</CardTitle>
              <CardDescription>{`${registriesQuery.data?.registries.length ?? 0} registry sources`}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-3 text-xs tracking-wider uppercase text-muted-foreground">Name</TableHead>
                  <TableHead className="px-3 text-xs tracking-wider uppercase text-muted-foreground">Status</TableHead>
                  <TableHead className="px-3 text-xs tracking-wider uppercase text-muted-foreground">Entries</TableHead>
                  <TableHead className="px-3 text-xs tracking-wider uppercase text-muted-foreground">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(registriesQuery.data?.registries ?? []).map((registry) => (
                  <TableRow key={registry.name}>
                    <TableCell className="px-3 align-top">
                      <strong>{registry.name}</strong>
                      <div className="text-muted-foreground text-sm">{registry.url}</div>
                    </TableCell>
                    <TableCell className="px-3 align-top">{registry.status}</TableCell>
                    <TableCell className="px-3 align-top">{registry.entryCount}</TableCell>
                    <TableCell className="px-3 align-top">
                      <Button className="cursor-pointer" onClick={() => setRegistryToRemove(registry.name)} size="lg" variant="ghost">
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Dialog onOpenChange={(open) => { if (!open) setRegistryToRemove(null) }} open={registryToRemove !== null}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{registryToRemove ? `Remove ${registryToRemove}?` : 'Remove registry'}</DialogTitle>
            {registryToRemove ? (
              <DialogDescription>
                {`This removes ${registryToRemove} from the hub registry configuration.`}
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button className="cursor-pointer" variant="ghost" />}>
              Cancel
            </DialogClose>
            <Button
              className="cursor-pointer"
              onClick={handleRemoveRegistry}
              size="lg"
              variant="destructive"
            >
              Remove registry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
