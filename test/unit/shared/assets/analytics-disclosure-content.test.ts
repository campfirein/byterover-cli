import {expect} from 'chai'
import {readFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {PRIVACY_POLICY_URL} from '../../../../src/shared/constants/privacy.js'

/**
 * Contract test on the analytics disclosure markdown content.
 *
 * Originally lived in the deleted `test/commands/analytics/enable.test.ts`
 * ("6. disclosure markdown contains all required sections"). Preserved
 * here because the markdown contract is independent of any specific
 * surface that renders it — it pins what PM/legal copy MUST contain.
 *
 * Section headers are load-bearing per the file's own preamble; a
 * future copy edit that accidentally drops one fails here loudly.
 */
describe('analytics-disclosure.md content contract', () => {
  it('includes the five required sections plus the privacy policy link', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const disclosurePath = resolve(here, '../../../../src/shared/assets/analytics-disclosure.md')
    const text = await readFile(disclosurePath, 'utf8')

    expect(text, 'what-is-collected section').to.match(/what is collected/i)
    expect(text, 'which-surfaces section').to.match(/which surfaces|surfaces are tracked/i)
    expect(text, 'where-it-goes section').to.match(/where (it )?goes/i)
    expect(text, 'cross-device alias section').to.match(/cross-device|alias/i)
    // Pin the new disable instruction to the post-M16.4 surface. A regression
    // that re-introduces the deleted `brv analytics disable` command (or any
    // other variant) fails here loudly.
    expect(text, 'how-to-disable section').to.match(/brv settings set analytics\.enabled false/i)
    expect(text, 'how-to-disable must not reference the deleted command').to.not.match(/brv analytics disable/i)
    expect(text, 'privacy policy link').to.include(PRIVACY_POLICY_URL)
  })
})
