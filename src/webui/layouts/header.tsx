import {Badge} from '@campfirein/byterover-packages/components/badge'
import {Tooltip, TooltipContent, TooltipTrigger} from '@campfirein/byterover-packages/components/tooltip'

import logo from '../assets/logo-byterover.svg'
import {AuthMenu} from '../features/auth/components/auth-menu'
import {HelpMenu} from '../features/help/components/help-menu'
import {ProjectDropdown} from '../features/project/components/project-dropdown'
import {BranchDropdown} from '../features/vc/components/branch-dropdown'
import {useTransportStore} from '../stores/transport-store'

export function Header() {
  const version = useTransportStore((s) => s.version)

  return (
    <header className="flex items-center gap-4 px-6 py-3.5">
      {/* Left: logo + project + branch */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 mr-2.5">
          <img alt="ByteRover" className="w-32" src={logo} />
          {version && <span className="text-primary-foreground text-xs font-medium">v{version}</span>}
        </div>

        <ProjectDropdown />

        <BranchDropdown />

        <Tooltip>
          <TooltipTrigger
            render={
              <Badge
                className="border-primary-foreground/40 bg-primary-foreground/15 text-primary-foreground mono gap-1 px-1.5 text-[9px] leading-none font-semibold tracking-[0.16em] uppercase"
                variant="outline"
              />
            }
          >
            <span aria-hidden className="bg-primary-foreground size-1 shrink-0 rounded-full" />
            <span className="leading-none">Local</span>
          </TooltipTrigger>
          <TooltipContent>You're viewing the local web UI, served from the daemon on your machine.</TooltipContent>
        </Tooltip>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right: help + login */}
      <div className="flex items-center gap-3">
        <HelpMenu />
        <AuthMenu />
      </div>
    </header>
  )
}
