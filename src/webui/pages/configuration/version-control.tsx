import {HitlSettingsPanel} from '../../features/vc/components/hitl-settings-panel'
import {IdentityPanel} from '../../features/vc/components/identity-panel'
import {RemotesPanel} from '../../features/vc/components/remotes-panel'

export function VersionControlSection() {
  return (
    <>
      <IdentityPanel />
      <RemotesPanel />
      <HitlSettingsPanel />
    </>
  )
}
