export const WebuiEvents = {
  GET_PORT: 'webui:getPort',
  SET_PORT: 'webui:setPort',
} as const

export type WebuiGetPortResponse =
  | {conflictPort: number; status: 'port_in_use'}
  | {port: number; requestedPort?: number; status: 'ok'}
  | {status: 'not_started'}

export interface WebuiSetPortRequest {
  port: number
}

export type WebuiSetPortResponse = {conflictPort: number; status: 'port_in_use'} | {port: number; status: 'ok'}
