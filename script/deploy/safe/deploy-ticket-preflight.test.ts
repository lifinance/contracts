/**
 * What the deploy pre-flight decides: which branch names yield a usable
 * suggestion, and what happens to a run that has no ticket with and without
 * someone to ask.
 *
 * `deploy-ticket-preflight-placement.test.ts` covers where the resulting check
 * sits; `proposal-intent.test.ts` covers the link validation it delegates to.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  branchTicketCandidate,
  deployTicketRefusal,
  resolveDeployTicket,
} from './deploy-ticket-preflight'
import { MISSING_TICKET_MESSAGE } from './proposal-intent'

const URL_1034 = 'https://linear.app/lifi-linear/issue/EXSC-1034'

/**
 * The message a call refused with, or the empty string when it did not refuse.
 *
 * Used in place of `expect(...).rejects`, whose bun typing the await-thenable
 * rule reads as non-thenable. An empty string contains none of the text the
 * cases assert, so a resolver that stopped refusing fails them rather than
 * passing on an unobserved promise.
 *
 * @param call - the resolution under test
 * @returns the refusal message, or '' if the call returned
 */
const refusalFrom = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call()
    return ''
  } catch (error) {
    return (error as Error).message
  }
}

/** Fails the test rather than the assertion: a prompt here means the run was interactive. */
const neverAsked = async (): Promise<string> => {
  throw new Error('the resolver asked when it should not have')
}

describe('branchTicketCandidate', () => {
  it('reads the id out of a Linear-generated branch', () => {
    expect(
      branchTicketCandidate(
        'daniel/exsc-1034-resolve-the-safe-proposal-ticket-before-the-first-deploy'
      )
    ).toBe('EXSC-1034')
  })

  it('reads an id that is the whole branch name', () => {
    expect(branchTicketCandidate('EXSC-1034')).toBe('EXSC-1034')
  })

  it('offers nothing for a branch that names no issue', () => {
    expect(branchTicketCandidate('main')).toBeUndefined()
    expect(branchTicketCandidate(undefined)).toBeUndefined()
  })

  it('does not invent an id out of a dated branch suffix', () => {
    // The case that decides the team-key class: a looser one reads this as
    // DEPLOYTEST-0917, which parseTicketLink accepts and expands into a URL for
    // an issue that does not exist. A well-formed wrong answer is worse than
    // none, because the operator has no reason to doubt it.
    expect(branchTicketCandidate('signing2-deploytest-0917')).toBeUndefined()
  })

  it('takes the first id when a branch names more than one', () => {
    expect(branchTicketCandidate('fix/exsc-1034-and-do-862')).toBe('EXSC-1034')
  })
})

describe('resolveDeployTicket with a ticket already supplied', () => {
  it('accepts a bare id and expands it, without asking', async () => {
    expect(
      await resolveDeployTicket({
        envTicket: 'EXSC-1034',
        branch: 'main',
        interactive: true,
        ask: neverAsked,
      })
    ).toBe(URL_1034)
  })

  it('refuses a malformed one instead of falling back to the branch', async () => {
    // The fallback is the dangerous reading: a typo'd ticket would silently
    // become the branch's id, which is a different issue than the one typed.
    expect(
      await refusalFrom(() =>
        resolveDeployTicket({
          envTicket: 'https://example.com/issue/EXSC-1034',
          branch: 'daniel/exsc-1034-title',
          interactive: false,
        })
      )
    ).toContain('not a Linear issue link')
  })

  it('treats a blank value as no ticket at all', async () => {
    expect(
      await refusalFrom(() =>
        resolveDeployTicket({
          envTicket: '   ',
          branch: 'main',
          interactive: false,
        })
      )
    ).toContain(MISSING_TICKET_MESSAGE)
  })
})

describe('resolveDeployTicket with nobody to ask', () => {
  it('refuses, and names the branch candidate so the fix is one command', async () => {
    expect(
      await refusalFrom(() =>
        resolveDeployTicket({
          branch: 'daniel/exsc-1034-title',
          interactive: false,
        })
      )
    ).toContain('export SAFE_PROPOSAL_TICKET=EXSC-1034')
  })

  it('refuses with the plain message when the branch names nothing', async () => {
    expect(
      await refusalFrom(() =>
        resolveDeployTicket({ branch: 'main', interactive: false })
      )
    ).toContain(MISSING_TICKET_MESSAGE)
    expect(deployTicketRefusal(undefined)).toBe(MISSING_TICKET_MESSAGE)
  })

  it('never attaches the branch candidate on its own', async () => {
    // The whole design rests on this: a deploy branch usually names the code
    // ticket rather than the rollout, so an unattended run must fail rather than
    // anchor a proposal to a guess.
    expect(
      await refusalFrom(() =>
        resolveDeployTicket({
          branch: 'daniel/exsc-1034-title',
          interactive: false,
        })
      )
    ).not.toBe('')
  })
})

describe('resolveDeployTicket with an operator to ask', () => {
  it('offers the branch candidate as the default, and an empty answer takes it', async () => {
    const asked: string[] = []
    const url = await resolveDeployTicket({
      branch: 'daniel/exsc-1034-title',
      interactive: true,
      ask: async (question) => {
        asked.push(question)
        return '\n'
      },
    })

    expect(url).toBe(URL_1034)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('[EXSC-1034]')
  })

  it('takes what was typed over the default', async () => {
    expect(
      await resolveDeployTicket({
        branch: 'daniel/exsc-1034-title',
        interactive: true,
        ask: async () => 'EXSC-686',
      })
    ).toBe('https://linear.app/lifi-linear/issue/EXSC-686')
  })

  it('refuses an empty answer when there is no default to fall back on', async () => {
    expect(
      await refusalFrom(() =>
        resolveDeployTicket({
          branch: 'main',
          interactive: true,
          ask: async () => '',
        })
      )
    ).toContain(MISSING_TICKET_MESSAGE)
  })

  it('refuses a malformed answer rather than re-asking forever', async () => {
    expect(
      await refusalFrom(() =>
        resolveDeployTicket({
          branch: 'main',
          interactive: true,
          ask: async () => 'not-a-ticket',
        })
      )
    ).toContain('not a Linear issue link')
  })
})
