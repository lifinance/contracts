/**
 * That every option the action prompt can offer is classified as one that ends
 * on a device screen or one that does not.
 *
 * `opensDeviceScreens` decides whether zone 3 prints, and it resolves an
 * unknown action towards printing — so a new prompt option added without a
 * classification would not break a signer, it would quietly put device
 * instructions in front of one who is broadcasting. Nothing else would notice.
 * This reads the options out of the spine rather than restating them, because a
 * list restated here is a list that stops matching.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  DEVICE_SIGNING_ACTIONS,
  NON_DEVICE_ACTIONS,
  opensDeviceScreens,
} from './signer-zones'

const SPINE = join(__dirname, 'confirm-safe-tx.ts')

/**
 * Every string the action prompt can put in front of a signer.
 *
 * Both shapes the spine uses: the literal the options array is seeded with, and
 * every value pushed onto it afterwards.
 *
 * @param text - The spine's source.
 * @returns The option strings, deduplicated.
 */
const promptOptions = (text: string): string[] => {
  const found = new Set<string>()
  for (const match of text.matchAll(/options\.push\('([^']+)'\)/gu))
    found.add(match[1] as string)
  for (const match of text.matchAll(/const options = \['([^']+)'\]/gu))
    found.add(match[1] as string)
  return [...found]
}

describe('the prompt options are all classified', () => {
  const text = readFileSync(SPINE, 'utf8')
  const options = promptOptions(text)

  it('finds the options in the spine at all', () => {
    // Without this the sweep below passes on an empty list, which is the shape
    // this file takes if the prompt is ever rewritten past the two patterns.
    expect(options.length).toBeGreaterThanOrEqual(6)
    expect(options).toContain('Do Nothing')
    expect(options).toContain('Sign')
  })

  it('places each option in exactly one set', () => {
    const unplaced = options.filter(
      (option) =>
        !DEVICE_SIGNING_ACTIONS.has(option) && !NON_DEVICE_ACTIONS.has(option)
    )
    const inBoth = options.filter(
      (option) =>
        DEVICE_SIGNING_ACTIONS.has(option) && NON_DEVICE_ACTIONS.has(option)
    )
    expect(unplaced).toEqual([])
    expect(inBoth).toEqual([])
  })

  it('names no action the prompt cannot offer', () => {
    // The other direction: a set carrying a string the prompt never produces is
    // a classification nobody is maintaining.
    const offered = new Set(options)
    for (const action of [...DEVICE_SIGNING_ACTIONS, ...NON_DEVICE_ACTIONS])
      expect(offered.has(action)).toBe(true)
  })

  it('shows the device instructions on the signing actions only', () => {
    expect(opensDeviceScreens('Sign')).toBe(true)
    expect(opensDeviceScreens('Sign & Execute')).toBe(true)
    expect(opensDeviceScreens('Sign and Execute With Deployer')).toBe(true)
    expect(opensDeviceScreens('Do Nothing')).toBe(false)
    expect(opensDeviceScreens('Execute')).toBe(false)
    expect(opensDeviceScreens('Execute with Deployer')).toBe(false)
  })

  it('resolves an unclassified action towards the instructions', () => {
    expect(opensDeviceScreens('Sign With A Second Device')).toBe(true)
  })

  describe('falsification — the assertions fail on the regressions they name', () => {
    it('fails when a new option is added without a classification', () => {
      const withNew = promptOptions(
        text.replace(
          "options.push('Sign')",
          "options.push('Sign')\noptions.push('Sign On Two Devices')"
        )
      )
      const unplaced = withNew.filter(
        (option) =>
          !DEVICE_SIGNING_ACTIONS.has(option) && !NON_DEVICE_ACTIONS.has(option)
      )
      expect(unplaced).toEqual(['Sign On Two Devices'])
    })

    it('fails when the option scraper stops matching the spine', () => {
      expect(promptOptions('nothing that looks like a prompt')).toEqual([])
    })
  })
})
