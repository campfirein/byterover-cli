import {Command, Flags} from '@oclif/core'
import {homedir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {install, resolveTargets} from '../../../../../packages/channel-skill/bin/install-lib.js'
import {writeJsonResponse} from '../../../lib/json-response.js'

const TARGET_OPTIONS = ['claude', 'codex', 'kimi', 'opencode', 'pi', 'all'] as const

type Format = 'json' | 'text'

export default class ChannelSkillInstall extends Command {
  public static description = 'Install the brv-channel SKILL.md into host agent skill discovery dirs'
  public static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --target claude',
    '<%= config.bin %> <%= command.id %> --brv-bin /usr/local/bin/brv --force',
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %> --format json',
  ]
  public static flags = {
    'brv-bin': Flags.string({
      description: "brv binary path to bake into SKILL.md (default: BRV_BIN env > 'brv' on PATH > literal 'brv')",
    }),
    'dry-run': Flags.boolean({default: false, description: 'Print planned writes without touching disk'}),
    force: Flags.boolean({default: false, description: 'Overwrite an existing SKILL.md that differs'}),
    format: Flags.string({default: 'text', description: 'Output format', options: ['text', 'json']}),
    path: Flags.string({description: 'Override target with an explicit absolute path'}),
    target: Flags.string({
      default: 'all',
      description: 'Host to target (or "all" for the three default paths)',
      options: [...TARGET_OPTIONS],
    }),
  }

  protected resolveHomeDir(): string {
    return homedir()
  }

  protected resolveSkillSource(): string {
    // From src/oclif/commands/channel/skill/install.ts → up 4 → src/ → into server/templates/channel-skill/.
    // After compile this resolves to dist/server/templates/channel-skill/SKILL.md (copied by `npm run build`).
    const currentDir = dirname(fileURLToPath(import.meta.url))
    return join(currentDir, '..', '..', '..', '..', 'server', 'templates', 'channel-skill', 'SKILL.md')
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(ChannelSkillInstall)
    const format = flags.format as Format

    const targets = resolveTargets({
      customPath: flags.path,
      homeDir: this.resolveHomeDir(),
      target: flags.target,
    })

    const result = await install({
      brvBin: flags['brv-bin'],
      dryRun: flags['dry-run'],
      force: flags.force,
      skillSource: this.resolveSkillSource(),
      targets,
    })

    if (format === 'json') {
      writeJsonResponse({command: 'channel skill install', data: result, success: true})
      return
    }

    this.log(`brv binary baked into SKILL.md: ${result.brvBin}`)
    const verb = flags['dry-run'] ? '(dry-run) would write' : '✓ installed'
    for (const p of result.written) this.log(`${verb} ${p}`)
    for (const p of result.skipped) this.log(`= unchanged ${p}`)
    if (!flags['dry-run'] && result.written.length > 0) {
      this.log('  Restart the host (Claude Code / Codex / Pi / kimi / opencode) to load.')
    }
  }
}
