/**
 * Tests for the extractor behind the sign-time calldata address gate.
 *
 * The grading is `calldata-address-check.ts`'s; these pin the part that decides
 * what it is handed — which role each address is found in, since the role is
 * what decides whether an unaccounted address blocks a signature.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { encodeFunctionData, type Address, type Hex } from 'viem'

import { DIAMOND_CUT_ABI, ZERO_ADDRESS } from '../shared/constants'

import {
  AddressGradeEnum,
  AddressRoleEnum,
  evaluateCalldataAddresses,
  type IAddressReference,
} from './calldata-address-check'
import {
  buildDeploymentIndex,
  collectAddressReferences,
  installedAddresses,
} from './calldata-address-collector'
import {
  TIMELOCK_SCHEDULE_BATCH_ABI,
  TIMELOCK_ZERO_PREDECESSOR,
} from './timelock-abi'

const FACET = '0x1111111111111111111111111111111111111111' as Address
const DIAMOND = '0x3333333333333333333333333333333333333333' as Address

const cut = (entries: { facetAddress: Address; action: number }[]): Hex =>
  encodeFunctionData({
    abi: DIAMOND_CUT_ABI,
    functionName: 'diamondCut',
    args: [
      entries.map((entry) => ({
        ...entry,
        functionSelectors: ['0xaabbccdd' as Hex],
      })),
      ZERO_ADDRESS as Address,
      '0x' as Hex,
    ],
  })

const scheduleBatch = (targets: Address[], payloads: Hex[]): Hex =>
  encodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    functionName: 'scheduleBatch',
    args: [
      targets,
      targets.map(() => 0n),
      payloads,
      TIMELOCK_ZERO_PREDECESSOR,
      TIMELOCK_ZERO_PREDECESSOR,
      86400n,
    ],
  })

describe('collectAddressReferences', () => {
  it('gives an installed facet the role that blocks on it', () => {
    const { references } = collectAddressReferences([
      cut([{ facetAddress: FACET, action: 0 }]),
    ])

    expect(
      references.find((reference) => reference.address === FACET)?.role
    ).toBe(AddressRoleEnum.FacetAdd)
  })

  // T2: a subtractive operation is never blocked by the unverifiability of what
  // it removes, and the role is the only thing that carries that distinction.
  it('gives a removal target the role that only warns', () => {
    const { references } = collectAddressReferences([
      cut([{ facetAddress: ZERO_ADDRESS as Address, action: 2 }]),
    ])

    expect(references[0]?.role).toBe(AddressRoleEnum.FacetRemove)
  })

  it('recovers addresses through a timelock envelope', () => {
    const { references } = collectAddressReferences([
      scheduleBatch([DIAMOND], [cut([{ facetAddress: FACET, action: 1 }])]),
    ])

    expect(
      references.some(
        (reference) =>
          reference.address === FACET &&
          reference.role === AddressRoleEnum.FacetReplace
      )
    ).toBe(true)
  })

  it('always references the init target, so a delegatecall is never unexamined', () => {
    const { references } = collectAddressReferences([
      cut([{ facetAddress: FACET, action: 0 }]),
    ])

    expect(
      references.some((reference) => reference.role === AddressRoleEnum.CutInit)
    ).toBe(true)
  })

  // An action outside Add/Replace/Remove has no refusal policy, and defaulting
  // it to one written for a known action would grade it under the wrong rule.
  it('leaves an unknown cut action unmapped rather than defaulting it', () => {
    const { references, undecodable } = collectAddressReferences([
      cut([{ facetAddress: FACET, action: 7 }]),
    ])

    // Unmapped, but not dropped: the evaluator turns any `undecodable` entry
    // into an error, so the cut it could not classify blocks rather than
    // leaving its address silently ungraded.
    expect(undecodable).toEqual(['call[0].diamondCut[0].cuts[0] (action 7)'])

    // Paired with the reference that must survive: an empty result would
    // satisfy the absence on its own and prove nothing about the skip.
    expect(references.map((reference) => reference.role)).toEqual([
      AddressRoleEnum.CutInit,
    ])
    expect(references.some((reference) => reference.address === FACET)).toBe(
      false
    )
  })

  it('reports a call it could not read through', () => {
    const { undecodable } = collectAddressReferences(['0xnothex' as Hex])
    expect(undecodable).toEqual(['call[0]'])
  })
})

describe('buildDeploymentIndex', () => {
  it('an unreachable record is unavailable, never an empty one', () => {
    const index = buildDeploymentIndex(undefined, [FACET], 'tunnel is down')

    expect(index.available).toBe(false)
    expect(index.unavailableReason).toContain('tunnel')

    // The distinction that matters: an empty record read as available would
    // grade every address as one nobody deployed.
    const verdict = evaluateCalldataAddresses(
      {
        network: 'arbitrum',
        references: [
          { address: FACET, role: AddressRoleEnum.FacetAdd, path: 'call[0]' },
        ],
      },
      index
    )
    expect(verdict.error).toBe(true)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.NotQueried)
  })

  it('names the deploy log as the source, the only one that may decide', () => {
    const index = buildDeploymentIndex(
      [
        {
          contractName: 'AcrossFacet',
          network: 'arbitrum',
          version: '1.0.0',
          address: FACET,
        },
      ],
      [FACET]
    )

    const verdict = evaluateCalldataAddresses(
      {
        network: 'arbitrum',
        references: [
          { address: FACET, role: AddressRoleEnum.FacetAdd, path: 'call[0]' },
        ],
        expectations: new Map([
          [FACET.toLowerCase(), { contractName: 'AcrossFacet' }],
        ]),
      },
      index
    )

    expect(verdict.error).toBe(false)
    expect(verdict.refuses).toBe(false)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.Resolved)
  })

  it('an address the record does not carry refuses in a blocking role', () => {
    const index = buildDeploymentIndex([], [FACET])

    const verdict = evaluateCalldataAddresses(
      {
        network: 'arbitrum',
        references: [
          { address: FACET, role: AddressRoleEnum.FacetAdd, path: 'call[0]' },
        ],
        expectations: new Map([
          [FACET.toLowerCase(), { contractName: 'AcrossFacet' }],
        ]),
      },
      index
    )

    expect(verdict.refuses).toBe(true)
  })
})

describe('installedAddresses', () => {
  const FACET = '0x00000000000000000000000000000000000000a1'
  const INIT = '0x00000000000000000000000000000000000000b2'

  const reference = (
    role: AddressRoleEnum,
    address: string
  ): IAddressReference => ({ address, role, path: `call[0].cuts[0]` })

  it('holds the address of a facet being added', () => {
    expect([
      ...installedAddresses([reference(AddressRoleEnum.FacetAdd, FACET)]),
    ]).toEqual([FACET])
  })

  it('holds the address of a facet being replaced', () => {
    expect([
      ...installedAddresses([reference(AddressRoleEnum.FacetReplace, FACET)]),
    ]).toEqual([FACET])
  })

  it('holds an init target, whose code runs against the diamond storage', () => {
    expect([
      ...installedAddresses([reference(AddressRoleEnum.CutInit, INIT)]),
    ]).toEqual([INIT])
  })

  it('holds a contract being registered as periphery', () => {
    expect([
      ...installedAddresses([
        reference(AddressRoleEnum.PeripheryRegistration, FACET),
      ]),
    ]).toEqual([FACET])
  })

  // The whole point of the set: a Remove installs nothing, so it contributes no
  // subject and gate G has nothing to read. The diamond being cut into is not
  // in the set either — it is not installed by this proposal.
  it('is empty for a cut that only removes', () => {
    expect([
      ...installedAddresses([
        reference(AddressRoleEnum.FacetRemove, ZERO_ADDRESS),
        reference(AddressRoleEnum.CutInit, ZERO_ADDRESS),
      ]),
    ]).toEqual([])
  })

  it('lowercases, so a checksummed reference matches a read address', () => {
    expect([
      ...installedAddresses([
        reference(
          AddressRoleEnum.FacetAdd,
          '0x00000000000000000000000000000000000000A1'
        ),
      ]),
    ]).toEqual([FACET])
  })
})
