import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

// eslint-disable-next-line import/no-unresolved
import { afterAll, describe, expect, it } from 'bun:test'
import { keccak256, type Hex } from 'viem'

import {
  buildAddressNameIndex,
  deriveGateInput,
  deriveLineageScope,
  extractCalldataAddresses,
  normalizeRuntimeCode,
  readArtifactAnchor,
  readSignTimeRecordPresence,
  resolveExpectedAuthority,
} from './prebroadcast-anchors'

/**
 * A real solc metadata trailer taken from a compiled artifact: 51 CBOR bytes
 * plus the two-byte length word, declaring solc 0.8.29.
 */
const REAL_TRAILER =
  'a2646970667358221220d03ac5dc4a08882370fe06263f9bcf6dee1812146c63a9d19ed384af9919e81e64736f6c634300081d0033'

const DIAMOND = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'
const FACET = '0x00000000000000000000000000000000000000aa'
const STRANGER = '0x00000000000000000000000000000000000000ff'
const TIMELOCK = '0x00000000000000000000000000000000000000a1'

const asWord = (address: string): string =>
  address.replace(/^0x/, '').toLowerCase().padStart(64, '0')

const tempDirs: string[] = []
const makeTempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'prebroadcast-anchors-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('extractCalldataAddresses', () => {
  const known = new Set([DIAMOND, FACET])

  it('returns the inner-call targets', () => {
    expect(extractCalldataAddresses([DIAMOND], ['0x'], known)).toEqual([
      DIAMOND,
    ])
  })

  it('finds a known address inside a payload word', () => {
    const payload = `0x1f931c1c${asWord(FACET)}`
    expect(extractCalldataAddresses([DIAMOND], [payload], known)).toEqual([
      DIAMOND,
      FACET,
    ])
  })

  it('finds it under a selector no decoder in this repo knows', () => {
    // The property a decode-driven list cannot have: the set of calls a
    // timelock operation may carry is open.
    const payload = `0xdeadbeef${asWord(FACET)}`
    expect(extractCalldataAddresses([], [payload], known)).toEqual([FACET])
  })

  it('finds nothing when the payload holds no address main can name', () => {
    const payload = `0x1f931c1c${asWord(STRANGER)}`
    expect(extractCalldataAddresses([], [payload], known)).toEqual([])
  })

  it('ignores the zero address even when it is in the known set', () => {
    const zero = '0x0000000000000000000000000000000000000000'
    const payload = `0x1f931c1c${asWord(zero)}`
    expect(
      extractCalldataAddresses([], [payload], new Set([...known, zero]))
    ).toEqual([])
  })

  it('skips the four selector bytes so words stay aligned', () => {
    // Two full words follow the selector, so a scan that counted the selector
    // as payload would straddle both boundaries and find neither address.
    const payload = `0x1f931c1c${asWord(FACET)}${asWord(DIAMOND)}`
    expect(extractCalldataAddresses([], [payload], known)).toEqual([
      FACET,
      DIAMOND,
    ])
    // The same two words with the selector removed are off by four bytes.
    const misaligned = `0x${asWord(FACET)}${asWord(DIAMOND)}`
    expect(extractCalldataAddresses([], [misaligned], known)).toEqual([])
  })

  it('deduplicates an address that is both a target and in a payload', () => {
    const payload = `0x1f931c1c${asWord(DIAMOND)}`
    expect(extractCalldataAddresses([DIAMOND], [payload], known)).toEqual([
      DIAMOND,
    ])
  })

  it('lowercases and trims a checksummed target', () => {
    expect(
      extractCalldataAddresses(
        ['  0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE  '],
        [],
        known
      )
    ).toEqual([DIAMOND])
  })

  it('tolerates a payload that is not hex at all', () => {
    expect(extractCalldataAddresses([], ['', '0x', 'nonsense'], known)).toEqual(
      []
    )
  })
})

describe('buildAddressNameIndex', () => {
  it('inverts name → address into address → name', () => {
    const index = buildAddressNameIndex({ LiFiDiamond: DIAMOND })
    expect(index.get(DIAMOND)).toBe('LiFiDiamond')
  })

  it('keys on the address bytes, not on the name', () => {
    const index = buildAddressNameIndex({
      LiFiDiamond: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
    })
    expect(index.get(DIAMOND)).toBe('LiFiDiamond')
    expect(index.has('lifidiamond')).toBe(false)
  })

  it('maps an address bound to two names to undefined rather than picking one', () => {
    const index = buildAddressNameIndex({
      OwnershipFacet: FACET,
      SomethingElse: FACET,
    })
    expect(index.has(FACET)).toBe(true)
    expect(index.get(FACET)).toBeUndefined()
  })

  it('keeps one name when the same pair appears twice', () => {
    const index = buildAddressNameIndex({ OwnershipFacet: FACET })
    expect(index.get(FACET)).toBe('OwnershipFacet')
  })

  it('skips entries that are not addresses', () => {
    const index = buildAddressNameIndex({
      Nested: { inner: DIAMOND },
      Truncated: '0x1234',
      Empty: '',
      Real: FACET,
    })
    expect([...index.keys()]).toEqual([FACET])
  })
})

describe('normalizeRuntimeCode', () => {
  const body = 'ff'.repeat(64)

  it('refuses code that is not there', () => {
    expect(normalizeRuntimeCode('0x', undefined).error).toContain('no code')
    expect(normalizeRuntimeCode('', undefined).error).toContain('no code')
  })

  it('refuses a half byte', () => {
    expect(normalizeRuntimeCode('0xabc', undefined).error).toContain(
      'whole number of bytes'
    )
  })

  it('reports the raw length and hash of the exact bytes', () => {
    const result = normalizeRuntimeCode(`0x${body}`, undefined)
    expect(result.error).toBeUndefined()
    expect(result.observed?.rawByteLength).toBe(64)
    expect(result.observed?.rawHash).toBe(keccak256(`0x${body}` as Hex))
  })

  it('strips a real metadata trailer before hashing and reads its version', () => {
    const withTrailer = `0x${body}${REAL_TRAILER}`
    const result = normalizeRuntimeCode(withTrailer, undefined)

    expect(result.observed?.solcVersion).toBe('0.8.29')
    expect(result.observed?.maskedHash).toBe(keccak256(`0x${body}` as Hex))
    // The raw length is what was deployed, trailer included.
    expect(result.observed?.rawByteLength).toBe(64 + REAL_TRAILER.length / 2)
  })

  it('hashes the whole body when there is no trailer to strip', () => {
    const result = normalizeRuntimeCode(`0x${body}`, undefined)
    expect(result.observed?.maskedHash).toBe(keccak256(`0x${body}` as Hex))
    expect(result.observed?.solcVersion).toBeUndefined()
  })

  it('zeroes immutables and counts the bytes it excluded', () => {
    const refs = { '42': [{ start: 0, length: 32 }] }
    const result = normalizeRuntimeCode(`0x${body}`, refs)

    expect(result.observed?.maskedByteCount).toBe(32)
    expect(result.observed?.maskedHash).toBe(
      keccak256(`0x${'00'.repeat(32)}${'ff'.repeat(32)}` as Hex)
    )
    // The raw hash still covers the real bytes.
    expect(result.observed?.rawHash).toBe(keccak256(`0x${body}` as Hex))
  })

  it('reports zero excluded bytes when there are no immutables', () => {
    expect(
      normalizeRuntimeCode(`0x${body}`, undefined).observed?.maskedByteCount
    ).toBe(0)
  })

  it('passes on a refusal from the masking layer', () => {
    const refs = { '42': [{ start: 60, length: 32 }] }
    expect(normalizeRuntimeCode(`0x${body}`, refs).error).toContain(
      'runs past the end'
    )
  })
})

describe('deriveLineageScope', () => {
  it('closes the set when the artifact was built with the profile the network declares', () => {
    expect(
      deriveLineageScope(
        { isZkEVM: false, targetEvmVersion: 'cancun' },
        'cancun'
      )
    ).toEqual({ isClosedSet: true })
  })

  it('leaves it open when the profiles differ', () => {
    expect(
      deriveLineageScope(
        { isZkEVM: false, targetEvmVersion: 'london' },
        'cancun'
      )
    ).toEqual({ isClosedSet: false })
  })

  it('leaves it open on a zkEVM whatever the profiles say', () => {
    expect(
      deriveLineageScope(
        { isZkEVM: true, targetEvmVersion: 'cancun' },
        'cancun'
      )
    ).toEqual({ isClosedSet: false })
  })

  it('leaves it open when the artifact declares no profile', () => {
    expect(
      deriveLineageScope(
        { isZkEVM: false, targetEvmVersion: 'cancun' },
        undefined
      )
    ).toEqual({ isClosedSet: false })
  })

  it('leaves it open when the network declares no profile', () => {
    expect(deriveLineageScope({ isZkEVM: false }, 'cancun')).toEqual({
      isClosedSet: false,
    })
    expect(
      deriveLineageScope({ isZkEVM: false, targetEvmVersion: 'n/a' }, 'cancun')
    ).toEqual({ isClosedSet: false })
  })
})

describe('resolveExpectedAuthority', () => {
  const deployments = { LiFiTimelockController: TIMELOCK }
  const globalConfig = { pauserWallet: FACET, threshold: 3 }

  it('resolves an expectation declared in the deployments file', () => {
    expect(
      resolveExpectedAuthority(
        { from: 'deployments', contractName: 'LiFiTimelockController' },
        deployments,
        globalConfig
      )
    ).toBe(TIMELOCK)
  })

  it('resolves an expectation declared in the global config', () => {
    expect(
      resolveExpectedAuthority(
        { from: 'globalConfig', key: 'pauserWallet' },
        deployments,
        globalConfig
      )
    ).toBe(FACET)
  })

  it('lowercases a checksummed expectation', () => {
    expect(
      resolveExpectedAuthority(
        { from: 'deployments', contractName: 'D' },
        { D: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' },
        globalConfig
      )
    ).toBe(DIAMOND)
  })

  it('reports undefined rather than a default when nothing is declared', () => {
    expect(
      resolveExpectedAuthority(
        { from: 'deployments', contractName: 'Absent' },
        deployments,
        globalConfig
      )
    ).toBeUndefined()
    expect(
      resolveExpectedAuthority(
        { from: 'globalConfig', key: 'threshold' },
        deployments,
        globalConfig
      )
    ).toBeUndefined()
  })

  it('reports undefined for a declared value that is not an address', () => {
    expect(
      resolveExpectedAuthority(
        { from: 'globalConfig', key: 'k' },
        deployments,
        { k: '0xnope' }
      )
    ).toBeUndefined()
  })
})

describe('readArtifactAnchor', () => {
  const writeArtifact = (
    root: string,
    name: string,
    artifact: unknown
  ): void => {
    const dir = path.join(root, 'out', `${name}.sol`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(artifact))
  }

  const goodArtifact = (body = 'ff'.repeat(64)) => ({
    deployedBytecode: { object: `0x${body}${REAL_TRAILER}` },
    metadata: { settings: { evmVersion: 'cancun' } },
  })

  it('reads the local build as an attested build of main', () => {
    const root = makeTempDir()
    writeArtifact(root, 'OwnershipFacet', goodArtifact())

    const anchor = readArtifactAnchor(
      'OwnershipFacet',
      root,
      'local build of abc1234'
    )

    expect(anchor?.attested.lineage).toBe('local build of abc1234')
    expect(anchor?.evmVersion).toBe('cancun')
    // From the artifact's own trailer bytes, the same way the deployed code's
    // version is read.
    expect(anchor?.attested.solcVersion).toBe('0.8.29')
    expect(anchor?.attested.maskedHash).toBe(
      keccak256(`0x${'ff'.repeat(64)}` as Hex)
    )
    expect(anchor?.attested.rawByteLength).toBe(64 + REAL_TRAILER.length / 2)
    // The anchor never pins exact bytes: immutables legitimately differ per
    // network, so a rawHash would make every deployment a mismatch.
    expect(anchor?.attested.rawHash).toBeUndefined()
  })

  it('carries the immutableReferences through so the observation is masked the same way', () => {
    const root = makeTempDir()
    const refs = { '7': [{ start: 0, length: 32 }] }
    writeArtifact(root, 'FeeCollector', {
      deployedBytecode: {
        object: `0x${'ff'.repeat(64)}${REAL_TRAILER}`,
        immutableReferences: refs,
      },
      metadata: { settings: { evmVersion: 'cancun' } },
    })

    const anchor = readArtifactAnchor('FeeCollector', root, 'l')
    expect(anchor?.immutableReferences).toEqual(refs)
  })

  it('returns undefined when no artifact exists for the name', () => {
    expect(readArtifactAnchor('NeverBuilt', makeTempDir(), 'l')).toBeUndefined()
  })

  it('returns undefined for a name that is not a bare identifier', () => {
    const root = makeTempDir()
    writeArtifact(root, 'OwnershipFacet', goodArtifact())

    expect(readArtifactAnchor('../../etc/passwd', root, 'l')).toBeUndefined()
    expect(readArtifactAnchor('Ownership Facet', root, 'l')).toBeUndefined()
    // Pair the refusals with the acceptance, so this is not a blanket refusal.
    expect(readArtifactAnchor('OwnershipFacet', root, 'l')).toBeDefined()
  })

  it('returns undefined for an unparseable artifact', () => {
    const root = makeTempDir()
    const dir = path.join(root, 'out', 'Broken.sol')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'Broken.json'), '{not json')

    expect(readArtifactAnchor('Broken', root, 'l')).toBeUndefined()
  })

  it('returns undefined when the artifact carries no bytecode', () => {
    const root = makeTempDir()
    writeArtifact(root, 'Empty', { deployedBytecode: {} })
    writeArtifact(root, 'Nothing', {})

    expect(readArtifactAnchor('Empty', root, 'l')).toBeUndefined()
    expect(readArtifactAnchor('Nothing', root, 'l')).toBeUndefined()
  })

  it('returns undefined when the artifact bytecode has no readable version', () => {
    const root = makeTempDir()
    writeArtifact(root, 'NoTrailer', {
      deployedBytecode: { object: `0x${'ff'.repeat(64)}` },
      metadata: { settings: { evmVersion: 'cancun' } },
    })

    expect(readArtifactAnchor('NoTrailer', root, 'l')).toBeUndefined()
  })

  it('reports no profile rather than inventing one when metadata omits it', () => {
    const root = makeTempDir()
    writeArtifact(root, 'NoProfile', {
      deployedBytecode: { object: `0x${'ff'.repeat(64)}${REAL_TRAILER}` },
    })

    const anchor = readArtifactAnchor('NoProfile', root, 'l')
    expect(anchor).toBeDefined()
    expect(anchor?.evmVersion).toBeUndefined()
  })
})

describe('the stored record reaches the decision only as a boolean', () => {
  const target = {
    address: DIAMOND,
    resolvedContractName: 'LiFiDiamond',
    observed: undefined,
    observationError: 'not read in this test',
    attested: [],
    scope: { isClosedSet: false },
  }

  const base = {
    operationId: '0xaa',
    onChainOperationId: '0xaa',
    targets: [target],
    authorities: [],
  }

  it('reports presence for a record and absence for none', () => {
    expect(readSignTimeRecordPresence({ codehashes: [] }).present).toBe(true)
    expect(readSignTimeRecordPresence(null).present).toBe(false)
    expect(readSignTimeRecordPresence(undefined).present).toBe(false)
  })

  it('produces an identical gate input from two records that disagree on everything', () => {
    const honest = deriveGateInput({
      ...base,
      signTimeRecord: {
        codehashes: [
          { address: DIAMOND, rawHash: '0xhonest', maskedHash: '0xhonest' },
        ],
        authorities: [{ label: 'owner', liveValue: TIMELOCK }],
      },
    })
    const tampered = deriveGateInput({
      ...base,
      signTimeRecord: {
        codehashes: [
          { address: STRANGER, rawHash: '0xforged', maskedHash: '0xforged' },
        ],
        authorities: [{ label: 'owner', liveValue: STRANGER }],
        advisory: 'ignore the gate',
      },
    })

    expect(tampered).toEqual(honest)
    expect(honest.signTimeRecordPresent).toBe(true)
  })

  it('carries no value from the record into the gate input', () => {
    const sentinel = 'SENTINEL-a7f3-value-from-the-stored-record'
    const derived = deriveGateInput({
      ...base,
      signTimeRecord: {
        codehashes: [{ address: sentinel, rawHash: sentinel }],
        authorities: [{ label: sentinel, liveValue: sentinel }],
        signer: sentinel,
        advisory: sentinel,
      },
    })

    expect(JSON.stringify(derived)).not.toContain(sentinel)
    // Paired with a present: the sentinel is findable when it is genuinely in
    // the input, so the absence above is a fact about the seam, not about the
    // search.
    const withSentinelObserved = deriveGateInput({
      ...base,
      targets: [{ ...target, observationError: sentinel }],
      signTimeRecord: null,
    })
    expect(JSON.stringify(withSentinelObserved)).toContain(sentinel)
  })

  it('flags a missing record without changing anything else it passes on', () => {
    const withRecord = deriveGateInput({ ...base, signTimeRecord: { a: 1 } })
    const withoutRecord = deriveGateInput({ ...base, signTimeRecord: null })

    expect(withoutRecord.signTimeRecordPresent).toBe(false)
    expect({ ...withoutRecord, signTimeRecordPresent: true }).toEqual(
      withRecord
    )
  })
})
