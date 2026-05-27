import {expect} from 'chai'

import {type AnalyticsEventName, AnalyticsEventNames} from '../../../../src/shared/analytics/event-names.js'

describe('AnalyticsEventNames', () => {
  it('should expose exactly the forty-six shipped event names', () => {
    expect(Object.keys(AnalyticsEventNames).sort()).to.deep.equal([
      'ANALYTICS_DISABLED',
      'AUTH_LOGIN',
      'AUTH_LOGOUT',
      'BRV_INIT',
      'CLI_INVOCATION',
      'CONNECTOR_INSTALLED',
      'CONTEXT_TREE_FILE_EDITED',
      'CURATE_OPERATION_APPLIED',
      'CURATE_RUN_COMPLETED',
      'DAEMON_RESET_EXECUTED',
      'DAEMON_START',
      'HUB_PACKAGE_INSTALLED',
      'HUB_REGISTRY_ADDED',
      'HUB_REGISTRY_REMOVED',
      'MCP_SESSION_START',
      'MCP_TOOL_CALLED',
      'ONBOARDING_AUTO_SETUP_STARTED',
      'ONBOARDING_COMPLETED',
      'QUERY_COMPLETED',
      'REVIEW_APPROVED',
      'REVIEW_REJECTED',
      'REVIEW_TOGGLED',
      'SETTING_CHANGED',
      'SETTING_RESET',
      'SOURCE_ADDED',
      'SOURCE_REMOVED',
      'SPACE_SWITCHED',
      'TASK_COMPLETED',
      'TASK_CREATED',
      'TASK_FAILED',
      'VC_BRANCHED',
      'VC_CHECKED_OUT',
      'VC_CLONED',
      'VC_COMMIT',
      'VC_DISCARDED',
      'VC_FETCHED',
      'VC_INIT',
      'VC_MERGED',
      'VC_PULLED',
      'VC_PUSHED',
      'VC_REMOTE_CHANGED',
      'VC_RESET_EXECUTED',
      'WEBUI_SESSION_ENDED',
      'WEBUI_SESSION_STARTED',
      'WORKTREE_ADDED',
      'WORKTREE_REMOVED',
    ])
  })

  it('should map each key to a snake_case wire string', () => {
    expect(AnalyticsEventNames.DAEMON_START).to.equal('daemon_start')
    expect(AnalyticsEventNames.CLI_INVOCATION).to.equal('cli_invocation')
    expect(AnalyticsEventNames.CURATE_OPERATION_APPLIED).to.equal('curate_operation_applied')
    expect(AnalyticsEventNames.CURATE_RUN_COMPLETED).to.equal('curate_run_completed')
    expect(AnalyticsEventNames.MCP_SESSION_START).to.equal('mcp_session_start')
    expect(AnalyticsEventNames.MCP_TOOL_CALLED).to.equal('mcp_tool_called')
    expect(AnalyticsEventNames.QUERY_COMPLETED).to.equal('query_completed')
    expect(AnalyticsEventNames.TASK_CREATED).to.equal('task_created')
    expect(AnalyticsEventNames.TASK_COMPLETED).to.equal('task_completed')
    expect(AnalyticsEventNames.TASK_FAILED).to.equal('task_failed')
  })

  it('should expose AnalyticsEventName as the union of values', () => {
    const sample: AnalyticsEventName = AnalyticsEventNames.DAEMON_START
    expect(sample).to.equal('daemon_start')
  })
})
