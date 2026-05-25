import {Skeleton} from '@campfirein/byterover-packages/components/skeleton'
import {LoaderCircle} from 'lucide-react'
import {Fragment, useMemo, useState} from 'react'
import {toast} from 'sonner'

import type {ConnectorType} from '../../../../shared/types/connector-type'

import {requiresAgentRestart} from '../../../../shared/types/connector-type'
import {SettingsSection} from '../../vc/components/settings-section'
import {useGetAgents} from '../api/get-agents'
import {useGetConnectors} from '../api/get-connectors'
import {useInstallConnector} from '../api/install-connector'
import {connectorLabels} from '../lib/connector-labels'
import {buildConnectorList, type ConnectorListEntry, entryName} from '../lib/sort-agents'
import {ConnectorRow} from './connector-row'

function buildSuccessMessage(name: string, verb: string, type: ConnectorType): string {
  const base = `${name} ${verb} ${connectorLabels[type]}.`
  return requiresAgentRestart(type) ? `${base} Restart the agent to apply.` : base
}

export function ConnectorsPanel() {
  const {data: connectorsData, isLoading: isLoadingConnectors} = useGetConnectors()
  const {data: agentsData, isLoading: isLoadingAgents} = useGetAgents()
  const installMutation = useInstallConnector()
  const [pendingAgent, setPendingAgent] = useState<string | undefined>()

  const isLoading = isLoadingConnectors || isLoadingAgents

  const entries = useMemo<ConnectorListEntry[]>(() => {
    if (!connectorsData || !agentsData) return []
    return buildConnectorList({agents: agentsData.agents, connectors: connectorsData.connectors})
  }, [connectorsData?.connectors, agentsData?.agents])

  const handleInstall = async (entry: Extract<ConnectorListEntry, {kind: 'available'}>) => {
    const {agent} = entry
    setPendingAgent(agent.name)
    try {
      await installMutation.mutateAsync({agentId: agent.id, connectorType: agent.defaultConnectorType})
      toast.success(buildSuccessMessage(agent.name, 'connected via', agent.defaultConnectorType))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to install connector')
    } finally {
      setPendingAgent(undefined)
    }
  }

  const handleTypeChange = async (
    entry: Extract<ConnectorListEntry, {kind: 'installed'}>,
    newType: ConnectorType,
  ) => {
    if (newType === entry.connector.connectorType) return

    setPendingAgent(entry.connector.agent)
    try {
      await installMutation.mutateAsync({agentId: entry.connector.agent, connectorType: newType})
      toast.success(buildSuccessMessage(entry.connector.agent, 'switched to', newType))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to switch connector type')
    } finally {
      setPendingAgent(undefined)
    }
  }

  return (
    <SettingsSection
      action={isLoading ? <LoaderCircle className="text-muted-foreground mt-1 size-4 animate-spin" /> : undefined}
      description="Manage how AI agents connect to ByteRover."
      title="Connectors"
    >
      {isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {entries.map((entry, index) => {
            const name = entryName(entry)
            const isPending = installMutation.isPending && pendingAgent === name
            return (
              <Fragment key={name}>
                <ConnectorRow
                  entry={entry}
                  isPending={isPending}
                  onInstall={(e) => {
                    handleInstall(e).catch(() => {})
                  }}
                  onTypeChange={(e, t) => {
                    handleTypeChange(e, t).catch(() => {})
                  }}
                />
                {index < entries.length - 1 && <div className="border-b" />}
              </Fragment>
            )
          })}
        </div>
      )}
    </SettingsSection>
  )
}
