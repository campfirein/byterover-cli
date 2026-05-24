import {Button} from '@campfirein/byterover-packages/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@campfirein/byterover-packages/components/dropdown-menu'
import {Tooltip, TooltipContent, TooltipTrigger} from '@campfirein/byterover-packages/components/tooltip'
import {ArrowUpRight, ChevronDown, LoaderCircle, Plus} from 'lucide-react'

import type {ConnectorType} from '../../../../shared/types/connector-type'

import {connectorLabels} from '../lib/connector-labels'
import {type ConnectorListEntry, entryName} from '../lib/sort-agents'
import {agentIcons} from './agent-icons'

type Props = {
  entry: ConnectorListEntry
  isPending: boolean
  onInstall: (entry: Extract<ConnectorListEntry, {kind: 'available'}>) => void
  onTypeChange: (entry: Extract<ConnectorListEntry, {kind: 'installed'}>, type: ConnectorType) => void
}

export function ConnectorRow({entry, isPending, onInstall, onTypeChange}: Props) {
  const name = entryName(entry)
  const icon = agentIcons[name]

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3 text-sm">
        {icon ? (
          <img alt="" className="size-5 shrink-0" src={icon} />
        ) : (
          <div className="size-5 shrink-0" />
        )}
        <div className="flex flex-col">
          <span>{name}</span>
          {entry.kind === 'installed' && <span className="text-primary text-xs">Connected</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        {entry.kind === 'docs' ? (
          <Button
            render={<a href={entry.docs.docsUrl} rel="noopener noreferrer" target="_blank" />}
            size="sm"
            variant="secondary"
          >
            Connect
            <ArrowUpRight className="size-3.5 shrink-0" />
          </Button>
        ) : entry.kind === 'installed' ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={isPending}
              render={<Button className="text-sm" disabled={isPending} size="sm" variant="secondary" />}
            >
              {isPending ? (
                <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
              ) : (
                <>
                  {connectorLabels[entry.connector.connectorType]}
                  <ChevronDown className="size-3.5 shrink-0" />
                </>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {entry.connector.supportedTypes.map((type) => (
                <DropdownMenuItem key={type} onClick={() => onTypeChange(entry, type)}>
                  {connectorLabels[type]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={`Add ${name} via ${connectorLabels[entry.agent.defaultConnectorType]}`}
                  className="size-8"
                  disabled={isPending}
                  onClick={() => onInstall(entry)}
                  size="icon-sm"
                  variant="outline"
                />
              }
            >
              {isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
            </TooltipTrigger>
            <TooltipContent>Add via {connectorLabels[entry.agent.defaultConnectorType]}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
