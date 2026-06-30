/* eslint-disable camelcase */
import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'

import type {ProjectLocationDTO} from '../../shared/transport/types/dto.js'

import {
  LocationsEvents,
  type LocationsGetRequest,
  type LocationsGetResponse,
} from '../../shared/transport/events/locations-events.js'
import {buildCliMetadata} from '../lib/build-cli-metadata.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../lib/daemon-client.js'
import {writeJsonResponse} from '../lib/json-response.js'

export default class Locations extends Command {
  public static description = 'List all registered projects and their context tree status'
  public static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --format json']
  public static flags = {
    format: Flags.string({
      char: 'f',
      default: 'text',
      description: 'Output format',
      options: ['text', 'json'],
    }),
  }

  protected async fetchLocations(
    cliMetadata: ReturnType<typeof buildCliMetadata>,
    options?: DaemonClientOptions,
  ): Promise<ProjectLocationDTO[]> {
    return withDaemonRetry<ProjectLocationDTO[]>(async (client) => {
      const request: LocationsGetRequest = {cli_metadata: cliMetadata}
      const response = await client.requestWithAck<LocationsGetResponse, LocationsGetRequest>(
        LocationsEvents.GET,
        request,
      )
      return response.locations
    }, options)
  }

  public async run(): Promise<void> {
    const {flags, metadata} = await this.parse(Locations)
    const isJson = flags.format === 'json'
    const cliMetadata = buildCliMetadata(this.id ?? 'locations', {flags, metadata})

    try {
      const locations = await this.fetchLocations(cliMetadata, {projectPath: process.cwd()})

      if (isJson) {
        writeJsonResponse({command: 'locations', data: {locations}, success: true})
      } else {
        this.formatTextOutput(locations)
      }
    } catch (error) {
      if (isJson) {
        writeJsonResponse({command: 'locations', data: {error: formatConnectionError(error)}, success: false})
      } else {
        this.log(formatConnectionError(error))
      }
    }
  }

  private formatLocationEntry(loc: ProjectLocationDTO): void {
    const label = loc.isCurrent ? '  ' + chalk.green('[current]') : loc.isActive ? '  ' + chalk.yellow('[active]') : ''
    const path = loc.isCurrent || loc.isActive ? chalk.bold(loc.projectPath) : loc.projectPath
    this.log(`  ${path}${label}`)
    if (loc.isInitialized) {
      this.log(chalk.dim('  └─ .brv/context-tree/'))
    } else {
      this.log(chalk.dim('  └─ .brv/context-tree/    (not initialized)'))
    }
  }

  private formatTextOutput(locations: ProjectLocationDTO[]): void {
    if (locations.length > 0) {
      this.log(`Registered Projects — ${locations.length} found`)
      this.log(chalk.dim('──────────────────────────────────────────'))
      for (const loc of locations) {
        this.formatLocationEntry(loc)
        this.log('')
      }
    } else {
      this.log('Registered Projects — none found')
    }
  }
}
