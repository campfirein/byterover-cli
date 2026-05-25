import type {ContentBlock} from '../../../shared/types/channel.js'

import {ChannelPromptEmptyError} from '../../core/domain/channel/errors.js'

/**
 * §8.4 prompt precedence + emptiness rules.
 *
 *   - `prompt` only            → `[{ type: 'text', text: prompt }]`
 *   - `promptBlocks` only      → `promptBlocks` unchanged
 *   - both                     → `[...promptBlocks, { type: 'text', text: prompt }]`
 *   - empty after normalisation → throws {@link ChannelPromptEmptyError}
 *
 * "Empty" means: `prompt` absent/whitespace AND `promptBlocks` absent or
 * `[]` or every block is a whitespace-only text block. Structured-only
 * prompts (resource_link with no text) are NOT empty.
 */

const isWhitespaceOnly = (text: string): boolean => text.trim() === ''

const blockIsEmpty = (block: ContentBlock): boolean => {
  if (block.type === 'text') return isWhitespaceOnly(block.text)
  // Non-text blocks (resource_link, resource, image, audio) are always
  // considered non-empty per CHANNEL_PROTOCOL.md §8.4.
  return false
}

export type NormalisePromptArgs = {
  prompt?: string
  promptBlocks?: ContentBlock[]
}

export const normalisePrompt = (args: NormalisePromptArgs): ContentBlock[] => {
  const hasPrompt = args.prompt !== undefined && !isWhitespaceOnly(args.prompt)
  const hasBlocks = args.promptBlocks !== undefined && args.promptBlocks.length > 0

  if (!hasPrompt && !hasBlocks) throw new ChannelPromptEmptyError()

  let result: ContentBlock[]
  if (hasBlocks && hasPrompt) {
    result = [...(args.promptBlocks ?? []), {text: args.prompt ?? '', type: 'text'}]
  } else if (hasBlocks) {
    result = args.promptBlocks ?? []
  } else {
    result = [{text: args.prompt ?? '', type: 'text'}]
  }

  if (result.every((b) => blockIsEmpty(b))) throw new ChannelPromptEmptyError()

  return result
}
