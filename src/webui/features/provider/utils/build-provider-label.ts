import type {ProviderGetActiveResponse} from '../../../../shared/transport/events/provider-events.js'
import type {ProviderDTO} from '../../../../shared/transport/types/dto.js'

const BYTEROVER_PROVIDER_ID = 'byterover'

/**
 * Builds the header trigger label for the active provider.
 *
 * The byterover provider has no end-user model selector, so the label is just
 * the provider name even when an internal default model is reported. Other
 * providers append "| <model>" when an active model is set.
 */
export function buildProviderLabel(activeProvider?: ProviderDTO, activeConfig?: ProviderGetActiveResponse): string {
  if (!activeProvider) return 'No provider configured'

  const showModelSuffix = activeProvider.id !== BYTEROVER_PROVIDER_ID && activeConfig?.activeModel
  return showModelSuffix ? `${activeProvider.name} | ${activeConfig.activeModel}` : activeProvider.name
}
