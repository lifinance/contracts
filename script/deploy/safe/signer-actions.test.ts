/**
 * That every option the action prompt can offer is classified as one that ends
 * on a device screen or one that does not.
 *
 * `opensDeviceScreens` decides whether zone 3 prints, and it resolves an
 * unknown action towards printing — so a new prompt option added without a
 * classification would not break a signer, it would quietly put device
 * instructions in front of one who is broadcasting. Nothing else would notice.
 * This reads the options from `SIGNER_ACTIONS`, the list the menu builder
 * filters, rather than restating them, because a list restated here is a list
 * that stops matching.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { DO_NOTHING, SIGNER_ACTIONS } from './signer-action-menu'
import {
  DEVICE_SIGNING_ACTIONS,
  NON_DEVICE_ACTIONS,
  opensDeviceScreens,
} from './signer-zones'

const SPINE = join(__dirname, 'confirm-safe-tx.ts')

/**
 * Every literal the spine pushes onto, or seeds, an options array.
 *
 * @param text - The source to scrape.
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

const unplacedOf = (options: readonly string[]): string[] =>
  options.filter(
    (option) =>
      !DEVICE_SIGNING_ACTIONS.has(option) && !NON_DEVICE_ACTIONS.has(option)
  )

describe('the prompt options are all classified', () => {
  const options: readonly string[] = SIGNER_ACTIONS

  it('builds the prompt options only through the menu builder', () => {
    // An option pushed in the spine itself would escape the list below.
    const spine = readFileSync(SPINE, 'utf8')
    expect(spine).toContain('buildSignerActionOptions({')
    expect(promptOptions(spine)).toEqual([])
  })

  it('finds the options in the menu builder at all', () => {
    // Without this the sweep below passes on an empty list.
    expect(options.length).toBeGreaterThanOrEqual(6)
    expect(options).toContain(DO_NOTHING)
    expect(options).toContain('Sign')
  })

  it('places each option in exactly one set', () => {
    const inBoth = options.filter(
      (option) =>
        DEVICE_SIGNING_ACTIONS.has(option) && NON_DEVICE_ACTIONS.has(option)
    )
    expect(unplacedOf(options)).toEqual([])
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
      expect(unplacedOf([...options, 'Sign On Two Devices'])).toEqual([
        'Sign On Two Devices',
      ])
    })

    it('fails when the spine scraper stops matching', () => {
      expect(promptOptions('nothing that looks like a prompt')).toEqual([])
      expect(promptOptions("options.push('Sign')")).toEqual(['Sign'])
    })
  })
})
