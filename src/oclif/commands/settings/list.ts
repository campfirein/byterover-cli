import Settings from './index.js'

export default class SettingsList extends Settings {
  public static description =
    'List user-configurable BRV settings. Changes apply after `brv restart`.'
  public static examples = [
    '<%= config.bin %> settings list',
    '<%= config.bin %> settings list --format json',
  ]
}
