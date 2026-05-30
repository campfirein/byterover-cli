import {useAuthStore} from '../features/auth/stores/auth-store'
import {useTransportStore} from '../stores/transport-store'

export function StatusBar() {
  const version = useTransportStore((state) => state.version)
  const spaceName = useAuthStore((state) => state.brvConfig?.spaceName)
  const teamName = useAuthStore((state) => state.brvConfig?.teamName)

  return (
    <footer className="flex flex-wrap gap-3 px-6 pb-6">
      <div className="inline-flex items-center gap-1.5 rounded-full bg-card/80 px-3 py-2 text-muted-foreground text-sm shadow-xs">
        <span className="text-muted-foreground uppercase tracking-wider text-xs">Daemon</span>
        <span>{version || 'Unknown'}</span>
      </div>
      <div className="inline-flex items-center gap-1.5 rounded-full bg-card/80 px-3 py-2 text-muted-foreground text-sm shadow-xs">
        <span className="text-muted-foreground uppercase tracking-wider text-xs">Space</span>
        <span>{teamName && spaceName ? `${teamName}/${spaceName}` : 'Not connected'}</span>
      </div>
    </footer>
  )
}
