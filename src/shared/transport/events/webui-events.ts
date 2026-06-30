export const WebuiEvents = {
  GET_PORT: 'webui:getPort',
  SET_PORT: 'webui:setPort',
} as const

type WebuiGetPortOkResponse = {port: number; requestedPort?: number; status: 'ok'}
type WebuiPortInUseResponse = {conflictPort: number; status: 'port_in_use'}
type WebuiSetPortOkResponse = {port: number; status: 'ok'}

export type WebuiGetPortResponse = WebuiGetPortOkResponse | WebuiPortInUseResponse | {status: 'not_started'}

export interface WebuiSetPortRequest {
  port: number
}

export type WebuiSetPortResponse = WebuiPortInUseResponse | WebuiSetPortOkResponse
