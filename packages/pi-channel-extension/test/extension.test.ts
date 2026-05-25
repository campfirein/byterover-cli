import {expect} from 'chai'

import channelExtension from '../src/extension.js'
import type {PiAutocompleteItem, PiExtensionAPI, PiRegisterCommandOptions} from '../src/pi-api.js'

describe('channelExtension entry (Slice 7.1a)', () => {
  it('registers a single `channel` command with description + completions + handler', () => {
    const registered: Array<{readonly name: string; readonly options: PiRegisterCommandOptions}> = []
    const fakePi: PiExtensionAPI = {
      registerCommand(name, options) {
        registered.push({name, options})
      },
    }

    channelExtension(fakePi)
    expect(registered).to.have.lengthOf(1)
    expect(registered[0]!.name).to.equal('channel')
    expect(registered[0]!.options.description).to.be.a('string')
    expect(registered[0]!.options.handler).to.be.a('function')
    expect(registered[0]!.options.getArgumentCompletions).to.be.a('function')
  })

  it('completion suggests matching subcommands and stays quiet inside subcommand args', () => {
    let captured: PiRegisterCommandOptions | undefined
    const fakePi: PiExtensionAPI = {
      registerCommand(_name, options) {
        captured = options
      },
    }

    channelExtension(fakePi)
    if (captured === undefined || captured.getArgumentCompletions === undefined) {
      throw new Error('extension did not install getArgumentCompletions')
    }

    const completionsForI = captured.getArgumentCompletions('i') as PiAutocompleteItem[] | null
    expect(completionsForI).to.not.equal(null)
    const values = (completionsForI ?? []).map((c) => c.value)
    expect(values).to.include('invite')

    const completionsAfterSpace = captured.getArgumentCompletions('mention ') as
      | PiAutocompleteItem[]
      | null
    expect(completionsAfterSpace).to.equal(null)

    const completionsForGarbage = captured.getArgumentCompletions('zzz') as
      | PiAutocompleteItem[]
      | null
    expect(completionsForGarbage).to.equal(null)
  })
})
