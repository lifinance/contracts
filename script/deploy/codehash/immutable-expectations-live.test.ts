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
import { readFileSync } from 'fs'

import { describe, expect, it } from 'bun:test' // eslint-disable-line import/no-unresolved

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
