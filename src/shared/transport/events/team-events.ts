import type {TeamDTO} from '../types/dto.js'

export const TeamEvents = {
  LIST: 'team:list',
} as const

export interface TeamListResponse {
  error?: string
  teams?: TeamDTO[]
}
