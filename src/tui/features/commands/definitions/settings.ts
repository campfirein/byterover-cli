import React from 'react'

import type {SlashCommand} from '../../../types/commands.js'

import {SettingsPage} from '../../settings/components/settings-page.js'

export const settingsCommand: SlashCommand = {
  action() {
    return {
      render: ({onCancel, onComplete}) => React.createElement(SettingsPage, {onCancel, onComplete}),
    }
  },
  description: 'View and edit user-configurable settings (restart required to apply)',
  name: 'settings',
}
