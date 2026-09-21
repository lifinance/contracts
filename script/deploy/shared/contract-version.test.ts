import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { readContractVersion } from './contract-version'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const SEAM = 'script/utils/extract-contract-version.sh'

/**
 * One table, two implementations. The bash seam and this module are separate
 * bodies of code by necessity — the version-control CI job is pure bash and
 * adding a bun install to it would slow the cheapest gate in the repo — so the
 * only thing keeping them honest is that both are driven from these cases.
 *
 * A disagreement here is the bug this table exists to catch: the workflow looks
 * up audit coverage by version while the audit gate compares content at that
 * same version, and two grammars mean one version's audits get checked against
 * another version's source (EXSC-1033).
 */
const CASES: {
  name: string
  source: string
  expected: ReturnType<typeof readContractVersion>
}[] = [
  {
    name: 'a bare release version',
    source: '/// @custom:version 1.0.0\ncontract Foo {}\n',
    expected: { kind: 'ok', version: '1.0.0', base: '1.0.0' },
  },
  {
    name: 'a fork overlay version',
    source: '/// @custom:version 2.1.3-tron\ncontract LibAsset {}\n',
    expected: { kind: 'ok', version: '2.1.3-tron', base: '2.1.3' },
  },
  {
    name: 'a multi-digit minor',
    source: '/// @custom:version 1.12.0\n',
    expected: { kind: 'ok', version: '1.12.0', base: '1.12.0' },
  },
  {
    name: 'a dotted prerelease suffix',
    source: '/// @custom:version 2.0.0-rc.1\n',
    expected: { kind: 'ok', version: '2.0.0-rc.1', base: '2.0.0' },
  },
  {
    // docs/TronFork.md: a redeploy of the same overlay takes -tron-r2, -tron-r3.
    name: 'a fork overlay revision',
    source: '/// @custom:version 2.1.3-tron-r2\n',
    expected: { kind: 'ok', version: '2.1.3-tron-r2', base: '2.1.3' },
  },
  {
    name: 'a tag whose value is only whitespace',
    source: '/// @custom:version   \ncontract Foo {}\n',
    expected: { kind: 'missing' },
  },
  {
    name: 'a tag below other natspec',
    source:
      '/// @title Foo\n/// @author LI.FI (https://li.fi)\n/// @custom:version 3.1.0\n',
    expected: { kind: 'ok', version: '3.1.0', base: '3.1.0' },
  },
  {
    name: 'the first of several tags (one file, two interfaces)',
    source:
      '/// @custom:version 1.0.0\n\ninterface A {}\n\n/// @custom:version 2.0.0\n',
    expected: { kind: 'ok', version: '1.0.0', base: '1.0.0' },
  },
  {
    name: 'a CRLF line ending',
    source: '/// @custom:version 1.0.1\r\ncontract Foo {}\r\n',
    expected: { kind: 'ok', version: '1.0.1', base: '1.0.1' },
  },
  {
    name: 'no tag at all',
    source: '/// @title Foo\ncontract Foo {}\n',
    expected: { kind: 'missing' },
  },
  {
    name: 'a double-slash comment, which is not a natspec tag',
    source: '// @custom:version 1.0.0\n',
    expected: { kind: 'missing' },
  },
  {
    name: 'a mention part-way through a line',
    source: 'contract Foo {} // @custom:version 9.9.9\n',
    expected: { kind: 'missing' },
  },
  {
    name: 'an indented tag, which natspec would not carry',
    source: '    /// @custom:version 1.0.0\n',
    expected: { kind: 'missing' },
  },
  {
    name: 'a four-component version',
    source: '/// @custom:version 2.1.3.4\n',
    expected: { kind: 'malformed', raw: '2.1.3.4' },
  },
  {
    name: 'a two-component version',
    source: '/// @custom:version 2.1\n',
    expected: { kind: 'malformed', raw: '2.1' },
  },
  {
    name: 'a v-prefixed version',
    source: '/// @custom:version v1.0.0\n',
    expected: { kind: 'malformed', raw: 'v1.0.0' },
  },
  {
    name: 'an empty suffix',
    source: '/// @custom:version 1.0.0-\n',
    expected: { kind: 'malformed', raw: '1.0.0-' },
  },
  {
    name: 'an uppercase suffix, so a suffix has one spelling',
    source: '/// @custom:version 2.1.3-TRON\n',
    expected: { kind: 'malformed', raw: '2.1.3-TRON' },
  },
  {
    name: 'an underscore suffix',
    source: '/// @custom:version 1.0.0_beta\n',
    expected: { kind: 'malformed', raw: '1.0.0_beta' },
  },
  {
    name: 'trailing prose after the version',
    source: '/// @custom:version 1.0.0 (deprecated)\n',
    expected: { kind: 'malformed', raw: '1.0.0 (deprecated)' },
  },
  {
    name: 'a tag with no value',
    source: '/// @custom:version\n',
    expected: { kind: 'missing' },
  },
]

describe('readContractVersion', () => {
  for (const { name, source, expected } of CASES)
    it(`reads ${name}`, () => {
      expect(readContractVersion(source)).toEqual(expected)
    })
})

/**
 * The verdict as the seam can express it: an exit code plus the version itself.
 * `base` is a convenience this module derives for callers that order versions,
 * so it has no counterpart on the bash side.
 */
type SeamVerdict =
  | { kind: 'ok'; version: string }
  | { kind: 'missing' }
  | { kind: 'malformed'; raw: string }

/**
 * Runs the bash seam against a source string and maps its exit code back onto
 * the same shape, so the two implementations are compared as verdicts rather
 * than as text.
 */
const runSeam = (source: string): SeamVerdict => {
  const dir = mkdtempSync(join(tmpdir(), 'contract-version-'))
  try {
    const file = join(dir, 'Foo.sol')
    writeFileSync(file, source)

    try {
      const stdout = execFileSync('bash', [join(repoRoot, SEAM), file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      return { kind: 'ok', version: stdout.trim() }
    } catch (error) {
      const failure = error as { status?: number; stdout?: string }
      if (failure.status === 2) return { kind: 'missing' }
      if (failure.status === 3)
        return { kind: 'malformed', raw: (failure.stdout ?? '').trim() }

      throw error
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Drops `base`, so parity is asserted on what both sides actually decide. */
const asSeamVerdict = (
  read: ReturnType<typeof readContractVersion>
): SeamVerdict =>
  read.kind === 'ok' ? { kind: 'ok', version: read.version } : read

describe(`${SEAM} agrees with readContractVersion`, () => {
  for (const { name, source, expected } of CASES)
    it(`reads ${name}`, () => {
      expect(runSeam(source)).toEqual(asSeamVerdict(expected))
    })
})

describe(`${SEAM} argument handling`, () => {
  it('reports a missing file rather than reporting no tag', () => {
    expect(() =>
      execFileSync('bash', [join(repoRoot, SEAM), '/nonexistent/Foo.sol'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ).toThrow()
  })

  it('reads a contract from the repo itself', () => {
    const stdout = execFileSync(
      'bash',
      [join(repoRoot, SEAM), join(repoRoot, 'src/Libraries/LibAsset.sol')],
      { encoding: 'utf8' }
    )

    // An overlay fork tags this same contract 2.1.3-tron (docs/TronFork.md).
    expect(stdout.trim()).toMatch(
      /^\d+\.\d+\.\d+(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/
    )
  })
})
