/**
 * Layer 2 against the repo's own registry, config and requirements — no stubbed
 * expectation anywhere.
 *
 * The fixtured tests in `immutable-expectations.test.ts` prove the grading
 * logic; this proves the thing that actually decides a signature, which is
 * whether the files on disk resolve to the value a slot is compared against. A
 * registry key that names nothing, a `configData` label pointing at a key
 * `config/` does not carry, or a merge that drops the registry section all
 * leave those tests green and this one red.
 *
 * Only the observation is synthesised, which is the correct side to synthesise:
 * it stands for the deployed bytecode, the one input a proposer controls.
 */
import { readFileSync, readdirSync } from 'fs'

import { describe, expect, it } from 'bun:test' // eslint-disable-line import/no-unresolved
import { keccak256, toHex } from 'viem'

import type {
  DeployRequirements,
  IImmutableEntry,
} from '../immutables/registry-schema'
import { mergeRequirements } from '../immutables/verify-immutable-registry'

import { priceImmutables } from './immutable-expectations'

const requirements = mergeRequirements(
  JSON.parse(
    readFileSync('script/deploy/resources/deployRequirements.json', 'utf8')
  ) as DeployRequirements,
  JSON.parse(
    readFileSync('script/deploy/resources/immutableRegistry.json', 'utf8')
  ) as Record<string, Record<string, IImmutableEntry>>
)

/** `value` as a 32-byte slot holds it. */
const slot = (name: string, value: string) => ({
  name,
  value: `0x${value.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`,
  slotByteCount: 32,
  byteCount: 32,
})

const price = (observed: ReturnType<typeof slot>[]) =>
  priceImmutables(
    {
      contractName: 'AcrossFacet',
      observed,
      network: 'mainnet',
      environment: 'production',
    },
    requirements
  )

describe('layer 2 against the repo’s own expectation files', () => {
  const SPOKE_POOL = '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5'

  it('verifies a slot holding the address config declares', () => {
    const result = price([slot('spokePool', SPOKE_POOL)])

    expect(result.decided).toBe(true)
    if (!result.decided) return
    expect(result.disagreements).toEqual([])
    expect(result.unpricedByteCount).toBe(0)
    expect(result.pricedByteCount).toBe(32)
    expect(result.slots[0]?.origin).toContain('across.json')
  })

  it('refuses a slot holding any other address', () => {
    const result = price([
      slot('spokePool', '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
    ])

    expect(result.decided).toBe(true)
    if (!result.decided) return
    expect(result.disagreements.map((one) => one.name)).toEqual(['spokePool'])
    expect(result.disagreeingByteCount).toBe(32)
  })

  it('leaves a contract the registry does not declare unpriced, never verified', () => {
    // `EXECUTOR` is not a slot EmergencyPauseFacet declares, so this stands in
    // for an immutable that lands in src/ before anyone files an entry for it —
    // the reading that must not drift into a pass now that the registry is full.
    const result = priceImmutables(
      {
        contractName: 'EmergencyPauseFacet',
        observed: [slot('EXECUTOR', SPOKE_POOL)],
        network: 'mainnet',
        environment: 'production',
      },
      requirements
    )

    expect(result.decided).toBe(true)
    if (!result.decided) return
    expect(result.unpricedByteCount).toBe(32)
    expect(result.pricedByteCount).toBe(0)
    expect(result.slots[0]?.status).toBe('undeclared')
  })
})

/**
 * The repo's own registry against the addresses actually in `deployments/`.
 *
 * The fixtured cases above prove the grading; these prove the blast radius of
 * the files on disk, which is the thing a signer meets. Each case names a
 * contract deployed across most of the fleet, so a registry edit that returns
 * it to the hard-blocking path fails here rather than at signing time.
 *
 * `slot32` stands in for the deployed bytecode only. Every expectation — the
 * address, the chain id, the literal — comes from the repo.
 */
describe('layer 2 across the deployments this repo records', () => {
  const deployed = (network: string): Record<string, string> =>
    JSON.parse(readFileSync(`deployments/${network}.json`, 'utf8')) as Record<
      string,
      string
    >

  const graded = (
    contractName: string,
    name: string,
    network: string,
    observedValue: string
  ) => {
    const result = priceImmutables(
      {
        contractName,
        observed: [slot(name, observedValue)],
        network,
        environment: 'production',
        address: deployed(network)[contractName] ?? '',
      },
      requirements
    )
    if (!result.decided) throw new Error(result.reason)
    return result.slots[0]
  }

  it('verifies EmergencyPauseFacet against its own recorded address across the fleet', () => {
    const networks = readdirSync('deployments').filter(
      (file) =>
        file.endsWith('.json') &&
        !file.includes('.diamond.') &&
        !file.includes('.staging.') &&
        !file.startsWith('_') &&
        deployed(file.replace(/\.json$/, '')).EmergencyPauseFacet?.startsWith(
          '0x'
        ) === true
    )
    expect(networks.length).toBeGreaterThan(50)

    for (const file of networks) {
      const network = file.replace(/\.json$/, '')
      const address = deployed(network).EmergencyPauseFacet as string
      const slotted = graded(
        'EmergencyPauseFacet',
        '_emergencyPauseFacetAddress',
        network,
        address
      )
      expect(`${network}:${slotted?.status}`).toBe(`${network}:verified`)
    }
  })

  it('verifies SupersetFacet.IS_HUB true on Arbitrum and false on a spoke', () => {
    expect(graded('SupersetFacet', 'IS_HUB', 'arbitrum', '0x01')?.status).toBe(
      'verified'
    )
    expect(graded('SupersetFacet', 'IS_HUB', 'base', '0x00')?.status).toBe(
      'verified'
    )
    expect(graded('SupersetFacet', 'IS_HUB', 'base', '0x01')?.status).toBe(
      'disagrees'
    )
  })

  it('holds the Permit2Proxy typehash literal to what the source hashes to', () => {
    const stub =
      'PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,'
    const witness = readFileSync('src/Periphery/Permit2Proxy.sol', 'utf8')
      .split('WITNESS_TYPE_STRING =')[1]
      ?.split(';')[0]
      ?.match(/"([^"]*)"/u)?.[1]
    expect(witness).toBeDefined()

    const expected = keccak256(toHex(`${stub}${witness ?? ''}`))
    expect(
      graded(
        'Permit2Proxy',
        'PERMIT_WITH_WITNESS_TYPEHASH',
        'mainnet',
        expected
      )?.status
    ).toBe('verified')
  })

  it('verifies a Tron slot against the base58 address the record carries', () => {
    // `deployments/tron.json` stores base58 and the compiler inlines 20-byte
    // hex, so a `selfAddress` evaluator on Tron compares two spellings of one
    // address. Pinned as a literal pair rather than translated here: a test
    // that computes its own expectation with the function under test agrees
    // with itself however wrong that function is.
    const RECORDED_BASE58 = 'TNDAp17M3vKJ432TLPGGEokuhzf4GTQXR6'
    const INLINED_HEX = '0x8645811516f6eea5d53a5d005a8f99adc280d220'
    expect(deployed('tron').EmergencyPauseFacet).toBe(RECORDED_BASE58)

    expect(
      graded(
        'EmergencyPauseFacet',
        '_emergencyPauseFacetAddress',
        'tron',
        INLINED_HEX
      )?.status
    ).toBe('verified')

    expect(
      graded(
        'EmergencyPauseFacet',
        '_emergencyPauseFacetAddress',
        'tron',
        `0x${'11'.repeat(20)}`
      )?.status
    ).toBe('disagrees')
  })

  it('expects zero where config omits a key the requirement lets deploy zero', () => {
    expect(
      graded('SymbiosisFacet', 'onchainSwapV3', 'zksync', `0x${'0'.repeat(40)}`)
        ?.status
    ).toBe('verified')
    expect(
      graded(
        'SymbiosisFacet',
        'onchainSwapV3',
        'zksync',
        '0x00000000000000000000000000000000deadbeef'
      )?.status
    ).toBe('disagrees')
  })

  it('keeps blocking an absent key the requirement does not let deploy zero', () => {
    const slotted = graded(
      'AcrossFacet',
      'spokePool',
      'abstract',
      `0x${'0'.repeat(40)}`
    )

    expect(slotted?.status).toBe('unpriceable')
    expect(slotted?.detail).toMatch(/has no value for abstract/u)
  })

  it('compares against the address config carries, zero allowance or not', () => {
    expect(
      graded(
        'SymbiosisFacet',
        'onchainSwapV3',
        'mainnet',
        `0x${'0'.repeat(40)}`
      )?.status
    ).toBe('disagrees')
  })

  it('separates a reviewed gap from an undeclared one on the same contract', () => {
    expect(
      graded(
        'Permit2Proxy',
        'LIFI_DIAMOND',
        'mainnet',
        '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5'
      )?.status
    ).toBe('acknowledgeable')
    expect(
      graded(
        'Permit2Proxy',
        'NOT_AN_IMMUTABLE',
        'mainnet',
        '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5'
      )?.status
    ).toBe('undeclared')
  })
})
