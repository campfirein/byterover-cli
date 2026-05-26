import type {LucideIcon} from 'lucide-react'

import {Database, Eye, Link2, PowerOff, Server} from 'lucide-react'

export type AnalyticsDisclosureSection = {
  body: string
  icon: LucideIcon
  label: string
}

export const ANALYTICS_PRIVACY_URL = 'https://docs.byterover.dev/privacy'

export const ANALYTICS_DISCLOSURE_SECTIONS: readonly AnalyticsDisclosureSection[] = [
  {
    body: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore.',
    icon: Database,
    label: 'WHAT IS COLLECTED',
  },
  {
    body: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore.',
    icon: Eye,
    label: 'WHICH SURFACES ARE TRACKED',
  },
  {
    body: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore.',
    icon: Server,
    label: 'WHERE IT GOES',
  },
  {
    body: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore.',
    icon: Link2,
    label: 'CROSS-DEVICE ALIAS',
  },
  {
    body: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore.',
    icon: PowerOff,
    label: 'HOW TO DISABLE',
  },
] as const
