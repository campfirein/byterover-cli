import {expect} from 'chai'

import ChannelTopic from '../../../src/oclif/commands/channel/index.js'

// Slice 8.8 — `brv channel --help` (and bare `brv channel`) renders a
// rich onboarding guide so a host LLM that runs `--help` cold has
// enough info to onboard reviewers without consulting the brv-channel
// skill or docs. The test below pins the load-bearing strings so a
// future refactor can't silently delete the onboarding flow.

describe('ChannelTopic (Slice 8.8 — channel --help)', () => {
  describe('description', () => {
    it('should be defined and non-trivial (≥ 200 chars)', () => {
      expect(ChannelTopic.description).to.be.a('string')
      expect(ChannelTopic.description.length).to.be.greaterThan(200)
    })

    it('should describe the four-step onboarding flow (onboard → new → invite → mention)', () => {
      expect(ChannelTopic.description).to.match(/onboard/i)
      expect(ChannelTopic.description).to.match(/\bnew\b/i)
      expect(ChannelTopic.description).to.match(/invite/i)
      expect(ChannelTopic.description).to.match(/mention/i)
    })

    it('should state Codex requires @zed-industries/codex-acp', () => {
      expect(ChannelTopic.description).to.include('@zed-industries/codex-acp')
    })

    it('should state Pi requires pi-acp', () => {
      expect(ChannelTopic.description).to.include('pi-acp')
    })

    it('should mention the skill install command', () => {
      expect(ChannelTopic.description).to.match(/channel skill install/)
    })

    it('should teach multi-agent fan-out + gather (Slice 8.12 — codex Option C)', () => {
      // Step 5 of the onboarding flow: orchestrate multiple agents in parallel
      // using --no-wait + subscribe --count, instead of N serial sync mentions.
      // Without this, a host LLM only knows the single-agent path.
      expect(ChannelTopic.description).to.match(/ORCHESTRATE/)
      expect(ChannelTopic.description).to.match(/--no-wait/)
      expect(ChannelTopic.description).to.match(/--count \d/)
      expect(ChannelTopic.description).to.match(/fan-out|in parallel/i)
    })

    it('should NOT use --exit-on-terminal in the multi-agent quorum example (Slice 8.12.1 — kimi/codex bug)', () => {
      // Independent kimi + codex review caught: combining --count N with
      // --exit-on-terminal in a multi-turn gather corrupts the quorum
      // because the first turn's `turn_state_change → completed` triggers
      // --exit-on-terminal before the slower turn's delivery lands.
      // The actual quorum SUBSCRIBE command lines must NOT use --exit-on-terminal
      // (cautionary prose mentioning the flag IS allowed and expected).
      // Pin via the structured `static examples` table where the command
      // string lives independent of surrounding prose.
      const quorumExample = ChannelTopic.examples.find(
        (e): e is {command: string; description: string} =>
          typeof e === 'object' &&
          e !== null &&
          'command' in e &&
          typeof (e as {command: unknown}).command === 'string' &&
          (e as {command: string}).command.includes('--count 2'),
      )
      expect(quorumExample, 'expected a quorum example with --count 2').to.not.equal(undefined)
      expect(quorumExample!.command, '--count 2 quorum must NOT use --exit-on-terminal').to.not.match(/--exit-on-terminal/)
    })

    it('should spell out the gather step (channel show <ch> <turnId> --json) instead of vague "synthesize" (Slice 8.12.1)', () => {
      // kimi Q5: "synthesize the response" was too vague. Host LLM needs
      // the explicit final step: read each turnId's finalAnswer via show.
      expect(ChannelTopic.description).to.match(/channel show .*--json/)
    })

    it('should mention approve/deny for permission requests (Slice 8.12)', () => {
      expect(ChannelTopic.description).to.match(/channel approve /)
      expect(ChannelTopic.description).to.match(/channel deny /)
    })

    it('should point to the brv-channel skill for the full error-recovery playbook (Slice 8.12)', () => {
      // The cold-start help mentions the two key error codes by name (so a host
      // LLM that hits them knows where to look) and points at the installed
      // skill for the full recovery playbook.
      expect(ChannelTopic.description).to.match(/CHANNEL_DRIVER_NOT_REGISTERED/)
      expect(ChannelTopic.description).to.match(/CHANNEL_PERMISSION_LOST_ON_RESTART/)
      expect(ChannelTopic.description).to.match(/recovery playbook|brv-channel skill/i)
    })

    it('should show the canonical --mode sync flags for mention', () => {
      expect(ChannelTopic.description).to.match(/--mode sync/)
      expect(ChannelTopic.description).to.match(/--suppress-thoughts/)
      expect(ChannelTopic.description).to.match(/--json/)
    })
  })

  describe('examples', () => {
    it('should expose at least four examples (onboard, new+invite, mention, skill install)', () => {
      expect(ChannelTopic.examples).to.be.an('array').with.length.greaterThan(3)
    })

    it('should include an onboard example covering kimi (the simplest native-ACP case)', () => {
      const text = JSON.stringify(ChannelTopic.examples)
      expect(text).to.match(/channel onboard kimi/)
    })

    it('should include a mention example using --mode sync', () => {
      const text = JSON.stringify(ChannelTopic.examples)
      expect(text).to.match(/channel mention .* --mode sync/)
    })

    it('should include a `channel skill install` example', () => {
      const text = JSON.stringify(ChannelTopic.examples)
      expect(text).to.match(/channel skill install/)
    })
  })
})
