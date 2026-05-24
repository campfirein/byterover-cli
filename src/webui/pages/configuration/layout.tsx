import {cn} from '@campfirein/byterover-packages/lib/utils'
import {NavLink, Outlet} from 'react-router-dom'

import {RestartBanner} from '../../features/settings/components/restart-banner'

type SectionDef = {
  end?: boolean
  label: string
  path: string
}

const SECTIONS: readonly SectionDef[] = [
  {end: true, label: 'General', path: '.'},
  {label: 'Connectors', path: 'connectors'},
  {label: 'Version control', path: 'version-control'},
]

export function ConfigurationLayout() {
  return (
    <div className="mx-auto flex h-full w-full max-w-5xl">
      <aside className="border-border w-56 shrink-0 border-r pt-4 pr-8">
        <nav className="flex flex-col gap-0.5">
          {SECTIONS.map((section) => (
            <NavLink
              className={({isActive}) =>
                cn('rounded-md px-2 py-1.5 text-sm transition-colors', {
                  'bg-muted text-foreground font-medium': isActive,
                  'text-muted-foreground hover:text-foreground': !isActive,
                })
              }
              end={section.end}
              key={section.path}
              to={section.path}
            >
              {section.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto px-8 pt-4 pb-8">
        <div className="mx-auto flex w-full flex-col gap-6 md:gap-12">
          <RestartBanner />
          <Outlet />
        </div>
      </main>
    </div>
  )
}
