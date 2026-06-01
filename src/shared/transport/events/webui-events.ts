export const WebuiEvents = {
  GET_PORT: 'webui:getPort',
  SET_PORT: 'webui:setPort',
} as const

type WebuiOkResponse = {port: number; requestedPort?: number; status: 'ok'}
type WebuiPortInUseResponse = {conflictPort: number; status: 'port_in_use'}

export type WebuiGetPortResponse = WebuiOkResponse | WebuiPortInUseResponse | {status: 'not_started'}

export interface WebuiSetPortRequest {
  port: number
}

export type WebuiSetPortResponse = WebuiOkResponse | WebuiPortInUseResponse
