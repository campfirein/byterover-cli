export const WebuiEvents = {
  GET_PORT: 'webui:getPort',
  SET_PORT: 'webui:setPort',
} as const

export type WebuiGetPortResponse =
  | {conflictPort: number; reason: 'port_in_use'}
  | {port: number}
  | {reason: 'not_started'}

export interface WebuiSetPortRequest {
  port: number
}

export type WebuiSetPortResponse = {conflictPort: number; reason: 'port_in_use'} | {port: number}
