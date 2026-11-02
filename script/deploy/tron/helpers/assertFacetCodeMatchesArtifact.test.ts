import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  assertFacetCodeMatchesArtifacts,
  describeCodeMismatch,
  type IRuntimeArtifact,
} from './assertFacetCodeMatchesArtifact'

/**
 * A solc-shaped metadata trailer: CBOR `{ ipfs: <34 bytes>, solc: 0.8.29 }` and its length word.
 *
 * @param hashByte - Fills the ipfs hash, so two trailers differ only there.
 * @returns The trailer as hex, without `0x`.
 */
const trailer = (hashByte: string): string =>
  `a264697066735822${hashByte.repeat(34)}64736f6c634300081d0033`

// 0x6080604052 then a 32-byte immutable slot at byte 5, then STOP.
const IMMUTABLE_START = 5
const body = (immutable: string): string =>
  `6080604052${immutable.padStart(64, '0')}00`

const ARTIFACT: IRuntimeArtifact = {
  deployedBytecode: { object: `0x${body('0')}${trailer('11')}` },
  immutableReferences: { '42': [{ start: IMMUTABLE_START, length: 32 }] },
}

describe('describeCodeMismatch', () => {
  it('matches the code the artifact describes', () => {
    expect(
      describeCodeMismatch(ARTIFACT.deployedBytecode?.object, ARTIFACT)
    ).toBeUndefined()
  })

  it('ignores the values of immutables', () => {
    expect(
      describeCodeMismatch(`0x${body('beef')}${trailer('11')}`, ARTIFACT)
    ).toBeUndefined()
  })

  it('ignores the metadata trailer', () => {
    expect(
      describeCodeMismatch(`0x${body('0')}${trailer('22')}`, ARTIFACT)
    ).toBeUndefined()
  })

  it('refuses code that differs outside immutables and the trailer', () => {
    const other = `0x6080604053${'0'.repeat(64)}00${trailer('11')}`

    expect(describeCodeMismatch(other, ARTIFACT)).toBe('on-chain code differs')
  })

  it('refuses code of another length', () => {
    expect(
      describeCodeMismatch(`0x${body('0')}00${trailer('11')}`, ARTIFACT)
    ).toBe("on-chain code is 92 bytes, the artifact's 91")
  })

  it.each([undefined, '0x'])('refuses an address with no code (%p)', (code) => {
    expect(describeCodeMismatch(code, ARTIFACT)).toBe('no code at that address')
  })

  it.each([{}, { deployedBytecode: { object: '0x' } }])(
    'refuses an artifact without runtime code',
    (artifact) => {
      expect(
        describeCodeMismatch(ARTIFACT.deployedBytecode?.object, artifact)
      ).toBe('the artifact has no deployedBytecode')
    }
  )

  it('refuses when the immutable offsets do not fit the code', () => {
    const artifact = {
      ...ARTIFACT,
      immutableReferences: { '42': [{ start: 500, length: 32 }] },
    }

    expect(
      describeCodeMismatch(ARTIFACT.deployedBytecode?.object, artifact)
    ).toStartWith('cannot mask immutables: ')
  })
})

describe('assertFacetCodeMatchesArtifacts', () => {
  /**
   * Writes an `out/` tree holding {@link ARTIFACT} for each name.
   *
   * @param names - Contracts to write an artifact for.
   * @returns The `out/` directory.
   */
  const outWith = (names: string[]): string => {
    const outRoot = mkdtempSync(join(tmpdir(), 'tron-facet-code-'))
    for (const name of names) {
      mkdirSync(join(outRoot, `${name}.sol`))
      writeFileSync(
        join(outRoot, `${name}.sol`, `${name}.json`),
        JSON.stringify(ARTIFACT)
      )
    }
    return outRoot
  }

  const chain =
    (code: Record<string, string>) =>
    async (address: string): Promise<string | undefined> =>
      code[address]

  async function expectRejects(
    promise: Promise<unknown>,
    match: RegExp
  ): Promise<void> {
    try {
      await promise
    } catch (error) {
      expect(String(error)).toMatch(match)
      return
    }
    throw new Error('expected a rejection')
  }

  it('passes when every facet matches its artifact', async () => {
    const outRoot = outWith(['A', 'B'])
    const code = ARTIFACT.deployedBytecode?.object ?? ''

    await assertFacetCodeMatchesArtifacts({
      facets: { A: 'TA', B: 'TB' },
      readRuntimeCode: chain({ TA: code, TB: code }),
      outRoot,
    })
  })

  it('refuses before anything is sent, naming only the facets that differ', async () => {
    const outRoot = outWith(['A', 'B'])
    const code = ARTIFACT.deployedBytecode?.object ?? ''

    await expectRejects(
      assertFacetCodeMatchesArtifacts({
        facets: { A: 'TA', B: 'TB' },
        readRuntimeCode: chain({ TA: code }),
        outRoot,
      }),
      /1 facet\(s\).*Nothing has been broadcast\.\nB \(TB\): no code at that address$/su
    )
  })

  it('refuses a facet with no artifact in out/', async () => {
    const outRoot = outWith([])

    await expectRejects(
      assertFacetCodeMatchesArtifacts({
        facets: { A: 'TA' },
        readRuntimeCode: chain({ TA: ARTIFACT.deployedBytecode?.object ?? '' }),
        outRoot,
      }),
      /A \(TA\): artifact not found at .*A\.sol\/A\.json/u
    )
  })

  it('runs in register-facets-to-diamond before the first cut is sent', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'register-facets-to-diamond.ts'),
      'utf8'
    )
    const main = source.slice(
      source.indexOf('async function registerFacetsToDiamond(')
    )
    const check = main.indexOf('await assertFacetCodeMatchesArtifacts(')

    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(main.indexOf('registerFacetsBatch('))
  })

  it('reads nothing when no facet is pending', async () => {
    const reads: string[] = []

    await assertFacetCodeMatchesArtifacts({
      facets: {},
      readRuntimeCode: async (address) => {
        reads.push(address)
        return undefined
      },
      outRoot: outWith([]),
    })
    expect(reads).toEqual([])
  })
})
