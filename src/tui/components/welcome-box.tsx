/**
 * Welcome Box Component
 *
 * Displays welcome message and getting started instructions for new users
 */

import {Box, Spacer, Text} from 'ink'
import React, {useRef} from 'react'

import {useTheme} from '../hooks/index.js'
import {formatTime} from '../utils/time.js'

export const WelcomeBox: React.FC = () => {
  const {
    theme: {colors},
  } = useTheme()

  const timestampRef = useRef(new Date())

  return (
    <Box flexDirection="column" marginBottom={1} width="100%">
      {/* Header */}
      <Box>
        <Text color={colors.primary}>· agent</Text>
        <Spacer />
        <Text color={colors.dimText}>{formatTime(timestampRef.current)}</Text>
      </Box>
      <Box borderColor={colors.border} borderStyle="single" flexDirection="column" gap={1} paddingX={1}>
        <Text bold color={colors.primary}>
          Welcome to ByteRover.
        </Text>
        <Box flexDirection="column">
          <Text color={colors.text}>
            ByteRover is your Memory Hub for storing and retrieving AI context.
          </Text>
          <Text color={colors.text}> </Text>
          <Text color={colors.text}>COMMANDS REFERENCE:</Text>
          <Text color={colors.text}>-------------------------------------------------------------</Text>
          <Text color={colors.text}>Action        Command       Description</Text>
          <Text color={colors.text}>-------------------------------------------------------------</Text>
          <Text color={colors.text}>CONNECT       <Text color={colors.warning}>/connectors</Text>   Connect ByteRover to your agent</Text>
          <Text color={colors.text}>STATUS        <Text color={colors.warning}>/status</Text>       Show project + context tree status</Text>
          <Text color={colors.text}>PROJECTS      <Text color={colors.warning}>/locations</Text>    List all registered projects</Text>
          <Text color={colors.text}>-------------------------------------------------------------</Text>
          <Text color={colors.text}> </Text>
          <Text color={colors.text}>GET STARTED:</Text>
          <Text color={colors.text}>Your memory hub is currently empty. Ask your coding agent:</Text>
          <Text color={colors.text}><Text color={colors.primary}>"Curate the folder structure of this repository"</Text></Text>
        </Box>
      </Box>
    </Box>
  )
}
