import {Avatar, AvatarFallback, AvatarImage} from '@campfirein/byterover-packages/components/avatar'
import {Button} from '@campfirein/byterover-packages/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@campfirein/byterover-packages/components/dropdown-menu'
import {useQueryClient} from '@tanstack/react-query'
import {LogOut, User} from 'lucide-react'
import {useEffect, useState} from 'react'

import {initials} from '../../../utils/initials'
import {AUTH_STATE_QUERY_ROOT} from '../api/get-auth-state'
import {useLogout} from '../api/logout'
import {useAuthStore} from '../stores/auth-store'
import {LoginDialog} from './login-dialog'

function UnauthorizedTrigger() {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <>
      <Button className="h-auto rounded-full p-0" onClick={() => setIsOpen(true)} variant="ghost">
        <Avatar>
          <AvatarFallback className="bg-transparent">
            <User className="size-4 shrink-0" />
          </AvatarFallback>
        </Avatar>
      </Button>

      <LoginDialog onOpenChange={setIsOpen} open={isOpen} />
    </>
  )
}

function AuthorizedMenu() {
  const user = useAuthStore((s) => s.user)
  const logoutMutation = useLogout()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (user) return
    queryClient.invalidateQueries({queryKey: AUTH_STATE_QUERY_ROOT}).catch(() => {})
  }, [queryClient, user])

  if (!user) {
    return (
      <Button disabled size="sm" variant="outline">
        <User className="size-4 shrink-0 text-muted-foreground" />
        <span>Signed in</span>
      </Button>
    )
  }

  const displayName = user.name ?? user.email

  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <Avatar className="cursor-pointer">
          <AvatarImage alt={displayName} src={user.avatarUrl} />
          <AvatarFallback>{initials(displayName)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--anchor-width) min-w-56" sideOffset={6}>
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="text-xs tracking-widest text-muted-foreground">Signed in</span>
            <span className="truncate text-sm font-medium text-card-foreground!">{user.email}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={logoutMutation.isPending} onClick={() => logoutMutation.mutate()}>
          <LogOut className="size-4 text-muted-foreground!" />
          <span className="text-sm">{logoutMutation.isPending ? 'Logging out…' : 'Log out'}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AuthMenu() {
  const isAuthorized = useAuthStore((s) => s.isAuthorized)
  const isLoadingInitial = useAuthStore((s) => s.isLoadingInitial)

  if (isLoadingInitial) {
    return (
      <Button disabled size="icon" variant="outline">
        <User className="size-4 shrink-0 text-muted-foreground animate-pulse" />
      </Button>
    )
  }

  return isAuthorized ? <AuthorizedMenu /> : <UnauthorizedTrigger />
}
