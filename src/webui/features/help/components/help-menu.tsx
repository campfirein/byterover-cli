import {Button} from '@campfirein/byterover-packages/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@campfirein/byterover-packages/components/dropdown-menu'
import {BookOpen, Bug, LifeBuoy} from 'lucide-react'

export function HelpMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="sm" variant="ghost">
            <LifeBuoy className="size-4 mr-1" />
            Help
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem
          render={
            <a href="https://docs.byterover.dev" rel="noopener noreferrer" target="_blank">
              <BookOpen />
              <span>Documentation</span>
            </a>
          }
        />

        <DropdownMenuItem
          render={
            <a href="https://github.com/campfirein/byterover-cli/issues" rel="noopener noreferrer" target="_blank">
              <Bug />
              <span>Report an issue</span>
            </a>
          }
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
