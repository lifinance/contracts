// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  buildSignerActionOptions,
  type ISignerActionMenuInput,
} from './signer-action-menu'

/** Every combination of the five facts the menu reads besides `refused`. */
const everyCase = (refused: boolean): ISignerActionMenuInput[] => {
  const cases: ISignerActionMenuInput[] = []
  for (let bits = 0; bits < 32; bits++)
    cases.push({
      refused,
      safeSigner: Boolean(bits & 1),
      hasSignedAlready: Boolean(bits & 2),
      wouldMeetThreshold: Boolean(bits & 4),
      showSignAndExecuteWithDeployer: Boolean(bits & 8),
      executable: Boolean(bits & 16),
    })
  return cases
}

const OPEN: ISignerActionMenuInput = {
  refused: false,
  safeSigner: false,
  hasSignedAlready: false,
  wouldMeetThreshold: true,
  showSignAndExecuteWithDeployer: true,
  executable: true,
}

describe('a refused proposal', () => {
  it('is offered Do Nothing alone, whatever else holds, for either kind of signer', () => {
    for (const input of everyCase(true))
      expect(buildSignerActionOptions(input)).toEqual(['Do Nothing'])
  })

  it('offers every option once nothing refuses it', () => {
    // The present half: the same input with `refused` false offers each option,
    // so the assertion above is about the refusal and not about a menu that
    // offers nothing.
    expect(buildSignerActionOptions(OPEN)).toEqual([
      'Do Nothing',
      'Sign',
      'Sign & Execute',
      'Sign and Execute With Deployer',
      'Execute',
      'Execute with Deployer',
    ])
    for (const input of everyCase(false))
      if (!input.hasSignedAlready)
        expect(buildSignerActionOptions(input)).toContain('Sign')
  })
})

describe('the options a proposal nothing refuses is offered', () => {
  it('never offers Sign & Execute to the Safe-signer key', () => {
    expect(buildSignerActionOptions({ ...OPEN, safeSigner: true })).toEqual([
      'Do Nothing',
      'Sign',
      'Sign and Execute With Deployer',
      'Execute',
      'Execute with Deployer',
    ])
  })

  it('offers no signing option to a signer who has already signed', () => {
    expect(
      buildSignerActionOptions({ ...OPEN, hasSignedAlready: true })
    ).toEqual(['Do Nothing', 'Execute', 'Execute with Deployer'])
  })

  it('offers no execute option before the threshold is met', () => {
    expect(
      buildSignerActionOptions({
        ...OPEN,
        executable: false,
        wouldMeetThreshold: false,
        showSignAndExecuteWithDeployer: false,
      })
    ).toEqual(['Do Nothing', 'Sign'])
  })
})
