import {Badge} from '@campfirein/byterover-packages/components/badge'
import {cn} from '@campfirein/byterover-packages/lib/utils'
import {NavLink, Outlet} from 'react-router-dom'

import {useTaskCounts} from '../features/tasks/stores/task-store'
import {useGetVcStatus} from '../features/vc/api/get-vc-status'
import {statusToFiles} from '../features/vc/utils/status-to-files'
import {Header} from './header'

type BadgeTone = 'active' | 'idle'

type TabDef = {
  badge?: string
  badgeTone?: BadgeTone
  label: string
  path: string
}

function useTabs(): TabDef[] {
  const {completed, inProgress, total} = useTaskCounts()
  const tasksBadge = total > 0 ? `${completed}/${total}` : undefined
  const tasksTone: BadgeTone = inProgress > 0 ? 'active' : 'idle'

  return [
    {label: 'Context', path: '/contexts'},
    {label: 'Changes', path: '/changes'},
    {badge: tasksBadge, badgeTone: tasksTone, label: 'Tasks', path: '/tasks'},
    {label: 'Configuration', path: '/configuration'},
  ]
}

function ChangesBadge() {
  const {data: status} = useGetVcStatus()
  const {staged, unmerged, unstaged} = statusToFiles(status)
  const count = staged.length + unstaged.length + unmerged.length
  if (count === 0) return null
  return (
    <span className="ml-1.5 rounded-md bg-[#4f3422] p-1 text-xs font-semibold tabular-nums text-[#ffc53d]">
      {count}
    </span>
  )
}

export function MainLayout() {
  const tabs = useTabs()

  return (
    <div className="flex h-screen flex-col">
      <Header />

      {/* Tabs */}
      <nav className="border-border flex gap-2 border-b px-6">
        {tabs.map((tab) => (
          <NavLink
            className={({isActive}) =>
              cn('flex items-center gap-1.5 border-b-2 px-2 pt-2 pb-3 text-sm transition-colors', {
                'border-primary-foreground text-primary-foreground font-medium': isActive,
                'border-transparent text-muted-foreground hover:text-foreground': !isActive,
              })
            }
            key={tab.path}
            to={tab.path}
          >
            <span>{tab.label}</span>
            {tab.badge && (
              <Badge className="tabular-nums" variant="secondary">
                {tab.badgeTone === 'active' && (
                  <span aria-hidden className="bg-primary-foreground size-1.5 shrink-0 rounded-full" />
                )}
                {tab.badge}
              </Badge>
            )}
            {tab.path === '/changes' && <ChangesBadge />}
          </NavLink>
        ))}
      </nav>

      {/* Content */}
      <main className="min-h-0 flex-1 overflow-y-auto p-4">
        <Outlet />
      </main>
    </div>
  )
}
