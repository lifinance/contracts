/**
 * What `assertProposalTicketForRun` does with the CLI's answer, and what it does
 * when a worker's environment has already lost the ticket.
 *
 * The bash half is where the two ways this feature can silently disable itself
 * live — a CLI that exits 0 without printing, and a re-`source`d env file that
 * blanks the exported ticket — so each case drives the real function with the
 * real `bunx` replaced by a stub that produces the output under test.
 */

import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const TIMEOUT_MS = 30_000

/**
 * A `bunx` that produces `stdout` and exits `code`, in front of PATH.
 *
 * @param stdout - what the stubbed pre-flight CLI prints
 * @param code - its exit status
 * @returns the directory to prepend to PATH
 */
const bunxStub = (stdout: string, code = 0): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-helper-stub-'))
  const path = join(dir, 'bunx')
  writeFileSync(path, `#!/bin/sh\nprintf '%s' "${stdout}"\nexit ${code}\n`)
  chmodSync(path, 0o755)
  return dir
}

/**
 * Runs the real helper and reports what the caller would see.
 *
 * @param args - the helper's arguments, environment first
 * @param options - the `bunx` stub's behaviour and any pre-set variables
 * @returns the helper's exit status and the ticket it left exported
 */
const callHelper = (
  args: string[],
  options: {
    stubStdout?: string
    stubExit?: number
    env?: Record<string, string>
  } = {}
): {
  rc: number
  ticket: string
  reason: string
  reasonMirror: string
  output: string
} => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // The post-clobber state a worker starts from, and the state a fresh run
    // starts from: set empty either way so neither decides a case by accident.
    SAFE_PROPOSAL_TICKET: '',
    RESOLVED_SAFE_PROPOSAL_TICKET: '',
    SAFE_PROPOSAL_REASON: '',
    RESOLVED_SAFE_PROPOSAL_REASON: '',
    ...(options.env ?? {}),
  }
  delete env.NODE_ENV
  if (options.stubStdout !== undefined || options.stubExit !== undefined)
    env.PATH = `${bunxStub(options.stubStdout ?? '', options.stubExit ?? 0)}:${
      env.PATH ?? ''
    }`

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      `source script/helperFunctions.sh >/dev/null 2>&1
       assertProposalTicketForRun ${args.map((a) => `"${a}"`).join(' ')}
       echo "RC=$?"
       echo "TICKET=[$SAFE_PROPOSAL_TICKET]"
       echo "REASON=[$SAFE_PROPOSAL_REASON]"
       echo "REASON_MIRROR=[$RESOLVED_SAFE_PROPOSAL_REASON]"`,
    ],
    {
      cwd: REPO_ROOT,
      env,
      timeout: TIMEOUT_MS,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )

  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.signalCode !== null && result.signalCode !== undefined)
    throw new Error(
      `child was killed by ${result.signalCode} after ${TIMEOUT_MS}ms, so its output proves nothing`
    )

  return {
    rc: Number(/RC=(\d+)/.exec(output)?.[1] ?? NaN),
    ticket: /TICKET=\[(.*)\]/.exec(output)?.[1] ?? '',
    reason: /REASON=\[(.*)\]/.exec(output)?.[1] ?? '',
    reasonMirror: /REASON_MIRROR=\[(.*)\]/.exec(output)?.[1] ?? '',
    output,
  }
}

const URL = 'https://linear.app/lifi-linear/issue/EXSC-1034'

describe('what the helper accepts from the pre-flight CLI', () => {
  it('exports the issue URL the CLI printed', () => {
    const result = callHelper(['production', 'gnosis'], { stubStdout: URL })

    expect(result.rc).toBe(0)
    expect(result.ticket).toBe(URL)
  })

  it('refuses a CLI that exited 0 without printing a ticket', () => {
    // Exit 0 is not consent: a CLI that never ran also exits 0 and prints
    // nothing. Without the check the run exports an empty ticket, reports
    // success, and refuses per network at the store instead.
    const result = callHelper(['production', 'gnosis'], { stubStdout: '' })

    expect(result.rc).toBe(1)
    expect(result.ticket).toBe('')
  })

  it('refuses output that is not a Linear issue URL', () => {
    const result = callHelper(['production', 'gnosis'], {
      stubStdout: 'https://example.com/issue/EXSC-1034',
    })

    expect(result.rc).toBe(1)
    expect(result.ticket).toBe('')
  })

  it('refuses when the CLI itself refused', () => {
    const result = callHelper(['production', 'gnosis'], {
      stubStdout: '',
      stubExit: 1,
    })

    expect(result.rc).toBe(1)
  })
})

describe('what the helper does once a ticket has been resolved', () => {
  it('restores a ticket a worker re-sourcing the env file blanked', () => {
    // The failure this exists for: `.env.example` ships a blank
    // SAFE_PROPOSAL_TICKET line, so a worker's `source .env` empties the
    // exported value. The stub echoes what it was handed, so the assertion
    // rests on the restored value having reached the resolver — a mirror that
    // was read but not restored leaves the stub with nothing to echo.
    const result = callHelper(['production', 'gnosis'], {
      stubStdout: '$SAFE_PROPOSAL_TICKET',
      env: { RESOLVED_SAFE_PROPOSAL_TICKET: URL },
    })

    expect(result.rc).toBe(0)
    expect(result.ticket).toBe(URL)
  })

  it('does not trust an inherited mirror, it re-resolves it', () => {
    // An inherited RESOLVED_SAFE_PROPOSAL_TICKET is not evidence: a stale or
    // malformed one would otherwise be exported unchecked. The stub refuses, so
    // a fast path that skipped resolution would pass this and the guard below
    // never run.
    const result = callHelper(['production', 'gnosis'], {
      stubStdout: 'not-a-linear-url',
      env: {
        RESOLVED_SAFE_PROPOSAL_TICKET: 'https://example.com/issue/EXSC-1',
      },
    })

    expect(result.rc).toBe(1)
    expect(result.ticket).toBe('')
  })
})

describe('when the helper asks nothing at all', () => {
  it('skips a staging run', () => {
    // A stub that refuses: reaching the CLI at all would fail these.
    const result = callHelper(['staging', 'gnosis'], {
      stubStdout: '',
      stubExit: 1,
    })

    expect(result.rc).toBe(0)
    expect(result.ticket).toBe('')
  })

  it('skips a production run whose networks are all testnets', () => {
    const result = callHelper(['production', 'sepolia'], {
      stubStdout: '',
      stubExit: 1,
    })

    expect(result.rc).toBe(0)
  })

  it('asks when one network of a mixed run would propose', () => {
    const result = callHelper(['production', 'sepolia', 'gnosis'], {
      stubStdout: URL,
    })

    expect(result.rc).toBe(0)
    expect(result.ticket).toBe(URL)
  })
})

describe('assertProposalTicketForRun reason line', () => {
  it('exports the reason the pre-flight printed on line 2', () => {
    const result = callHelper(['production', 'gnosis'], {
      stubStdout: `${URL}\nrehearsing the sign-time gates\n`,
    })
    expect(result.rc).toBe(0)
    expect(result.ticket).toBe(URL)
    expect(result.reason).toBe('rehearsing the sign-time gates')
  })

  // The ticket is what blocks; a pre-flight that collected no reason still has
  // to hand the run its ticket rather than failing or exporting a blank line.
  it('keeps the ticket when line 2 is empty', () => {
    const result = callHelper(['production', 'gnosis'], {
      stubStdout: `${URL}\n\n`,
    })
    expect(result.rc).toBe(0)
    expect(result.ticket).toBe(URL)
    expect(result.reason).toBe('')
  })

  // A second rollout in the same shell inherits the first one's exports. The
  // pre-flight was offered that reason and returned none, so carrying it would
  // label these proposals with the previous rollout's reason.
  it('drops a previous rollout reason when the pre-flight returns none', () => {
    const result = callHelper(['production', 'gnosis'], {
      stubStdout: `${URL}\n\n`,
      env: {
        SAFE_PROPOSAL_REASON: 'the previous rollout',
        RESOLVED_SAFE_PROPOSAL_REASON: 'the previous rollout',
      },
    })
    expect(result.rc).toBe(0)
    expect(result.ticket).toBe(URL)
    expect(result.reason).toBe('')
    expect(result.reasonMirror).toBe('')
  })
})
