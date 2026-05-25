import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import type {IBillingConfigStore} from '../../core/interfaces/storage/i-billing-config-store.js'

export interface FileBillingConfigStoreOptions {
  baseDir: string
}

const PROVIDER_CONFIG_FILE = 'brv-provider.json'

interface ProviderConfigJson extends Record<string, unknown> {
  billing?: {
    pinnedTeamId?: string
  }
}

export class FileBillingConfigStore implements IBillingConfigStore {
  private readonly baseDir: string
  private readonly configPath: string

  public constructor(options: FileBillingConfigStoreOptions) {
    this.baseDir = options.baseDir
    this.configPath = join(options.baseDir, PROVIDER_CONFIG_FILE)
  }

  public async getPinnedTeamId(): Promise<string | undefined> {
    const json = await this.readJson()
    return json.billing?.pinnedTeamId
  }

  public async setPinnedTeamId(teamId: string | undefined): Promise<void> {
    const json = await this.readJson()
    const billing = {...json.billing}
    if (teamId === undefined) {
      delete billing.pinnedTeamId
    } else {
      billing.pinnedTeamId = teamId
    }

    const next: ProviderConfigJson = {...json, billing}
    if (Object.keys(billing).length === 0) delete next.billing
    await this.writeJson(next)
  }

  private async readJson(): Promise<ProviderConfigJson> {
    try {
      const content = await readFile(this.configPath, 'utf8')
      const parsed: unknown = JSON.parse(content)
      if (!isRecord(parsed)) return {}
      const result: ProviderConfigJson = {...parsed}
      if (isRecord(parsed.billing) && typeof parsed.billing.pinnedTeamId === 'string') {
        result.billing = {pinnedTeamId: parsed.billing.pinnedTeamId}
      } else {
        delete result.billing
      }

      return result
    } catch {
      return {}
    }
  }

  private async writeJson(json: ProviderConfigJson): Promise<void> {
    await mkdir(this.baseDir, {recursive: true})
    await writeFile(this.configPath, JSON.stringify(json, null, 2), 'utf8')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
