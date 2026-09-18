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
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'

import { DIAMOND_CUT_ABI, ZERO_ADDRESS } from '../shared/constants'

import {
  AddressGradeEnum,
  AddressRoleEnum,
  evaluateCalldataAddresses,
  type IAddressReference,
} from './calldata-address-check'
import {
  authoritiesOfInstalled,
  buildDeploymentIndex,
  collectAddressReferences,
  installedAddresses,
  referencedNames,
} from './calldata-address-collector'
import type { IPreBroadcastAuthority } from './prebroadcast-authorities'
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
    const index = buildDeploymentIndex(undefined, [FACET], [], 'tunnel is down')

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
  it('is empty for the cut a removal is actually written as', () => {
    expect([
      ...installedAddresses([
        reference(AddressRoleEnum.FacetRemove, ZERO_ADDRESS),
        reference(AddressRoleEnum.CutInit, ZERO_ADDRESS),
      ]),
    ]).toEqual([])
  })

  // The role is what decides, not the zero address that usually accompanies it.
  // `LibDiamond` requires zero in a removal's facet slot, so a non-zero one is
  // a cut that will revert — and a gate that read it as an install would be
  // reading the slot rather than the action.
  it('drops a removal that names a non-zero address', () => {
    expect([
      ...installedAddresses([reference(AddressRoleEnum.FacetRemove, FACET)]),
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

describe('authoritiesOfInstalled', () => {
  const DIAMOND = '0x0000000000000000000000000000000000000d1a'
  const NEW_FACET = '0x00000000000000000000000000000000000000a1'

  const authority = (
    contractAddress: string,
    label: string
  ): IPreBroadcastAuthority => ({
    label,
    contractAddress,
    liveValue: '0x1',
    expectedValue: '0x1',
    expectationSource: 'globalConfig',
    readError: undefined,
  })

  const removeOnly = [
    {
      address: ZERO_ADDRESS,
      role: AddressRoleEnum.FacetRemove,
      path: 'call[0].cuts[0]',
    },
  ]

  // The case that sent this gate asking about a diamond's owner on a proposal
  // that removes a facet from it: the diamond is what the cut is applied to,
  // never what the cut installs.
  it('drops the diamond being cut into, on a cut that only removes', () => {
    expect(
      authoritiesOfInstalled(
        [
          authority(DIAMOND, 'LiFiDiamond.owner()'),
          authority(DIAMOND, 'LiFiDiamond.pauserWallet()'),
        ],
        removeOnly
      )
    ).toEqual([])
  })

  // The direction that keeps the narrowing honest: an address this proposal
  // does install stays a subject, so the gate is narrowed and not disabled.
  it('keeps an authority on a contract the proposal installs', () => {
    const subject = authority(NEW_FACET, 'ERC20Proxy.owner()')

    expect(
      authoritiesOfInstalled(
        [subject, authority(DIAMOND, 'LiFiDiamond.owner()')],
        [
          {
            address: NEW_FACET,
            role: AddressRoleEnum.PeripheryRegistration,
            path: 'call[0]',
          },
          ...removeOnly,
        ]
      )
    ).toEqual([subject])
  })

  it('matches a checksummed reference against a lowercased read address', () => {
    const subject = authority(NEW_FACET, 'ERC20Proxy.owner()')

    expect(
      authoritiesOfInstalled(
        [subject],
        [
          {
            address: '0x00000000000000000000000000000000000000A1',
            role: AddressRoleEnum.FacetAdd,
            path: 'call[0].cuts[0]',
          },
        ]
      )
    ).toEqual([subject])
  })
})

const PERIPHERY = '0x2222222222222222222222222222222222222222' as Address

const REGISTER_PERIPHERY_ABI = parseAbi([
  'function registerPeripheryContract(string,address)',
])

const register = (name: string, address: Address): Hex =>
  encodeFunctionData({
    abi: REGISTER_PERIPHERY_ABI,
    functionName: 'registerPeripheryContract',
    args: [name, address],
  })

describe('periphery registrations are collected with the name they bind', () => {
  it('finds a registration sent directly', () => {
    const { references, undecodable } = collectAddressReferences([
      register('Executor', PERIPHERY),
    ])

    expect(undecodable).toEqual([])
    expect(references).toEqual([
      {
        address: PERIPHERY,
        role: AddressRoleEnum.PeripheryRegistration,
        path: 'call[0].registerPeripheryContract[0]',
        registeredName: 'Executor',
      },
    ])
  })

  it('finds one wrapped in a timelock batch, beside a cut', () => {
    const { references, undecodable } = collectAddressReferences([
      scheduleBatch(
        [DIAMOND, DIAMOND],
        [
          cut([{ facetAddress: FACET, action: 0 }]),
          register('Patcher', PERIPHERY),
        ]
      ),
    ])

    expect(undecodable).toEqual([])
    expect(
      references.filter(
        (reference) => reference.role === AddressRoleEnum.PeripheryRegistration
      )
    ).toEqual([
      {
        address: PERIPHERY,
        role: AddressRoleEnum.PeripheryRegistration,
        path: 'call[0].registerPeripheryContract[0]',
        registeredName: 'Patcher',
      },
    ])
    // Both walks read the same envelope, so a registration beside a cut must
    // not cost the cut.
    expect(
      references.some(
        (reference) => reference.role === AddressRoleEnum.FacetAdd
      )
    ).toBe(true)
  })

  it('numbers several registrations in one envelope', () => {
    const { references } = collectAddressReferences([
      scheduleBatch(
        [DIAMOND, DIAMOND],
        [register('Executor', PERIPHERY), register('Patcher', FACET)]
      ),
    ])

    expect(
      references
        .filter(
          (reference) =>
            reference.role === AddressRoleEnum.PeripheryRegistration
        )
        .map((reference) => reference.path)
    ).toEqual([
      'call[0].registerPeripheryContract[0]',
      'call[0].registerPeripheryContract[1]',
    ])
  })

  it('names each distinct registry name the record has to answer for', () => {
    const { references } = collectAddressReferences([
      scheduleBatch(
        [DIAMOND, DIAMOND],
        [register('Executor', PERIPHERY), register('Executor', FACET)]
      ),
    ])

    expect(referencedNames(references)).toEqual(['Executor'])
  })

  it('reports a registration hidden inside an envelope it cannot open', () => {
    // A `multiSend`-shaped wrapper is not unwrapped, so the registration inside
    // it is never graded. Reporting it is what stops the envelope being a bypass.
    const hidden = ('0xdeadbeef' +
      register('Executor', PERIPHERY).slice(2)) as Hex
    const { references, undecodable } = collectAddressReferences([hidden])

    expect(references).toEqual([])
    expect(undecodable.join(' ')).toContain('registerPeripheryContract')
  })

  it('refuses a collected registration the record has superseded', () => {
    const { references } = collectAddressReferences([
      register('Executor', PERIPHERY),
    ])

    const verdict = evaluateCalldataAddresses(
      { network: 'mainnet', references },
      buildDeploymentIndex(
        [
          {
            contractName: 'Executor',
            network: 'mainnet',
            version: '2.0.0',
            address: PERIPHERY,
            timestamp: '2023-07-27 16:43:51',
          },
          {
            contractName: 'Executor',
            network: 'mainnet',
            version: '2.1.0',
            address: FACET,
            timestamp: '2025-09-09 16:50:17',
          },
        ],
        references.map((reference) => reference.address),
        referencedNames(references)
      )
    )

    expect(verdict.refuses).toBe(true)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.NameMismatch)
  })
})

describe('the aligned-selector scan runs only where no reader looked', () => {
  const REGISTER_PERIPHERY_SELECTOR = '0x5c2ed36a' as Hex

  const cutCarrying = (selectors: Hex[], initCalldata: Hex): Hex =>
    encodeFunctionData({
      abi: DIAMOND_CUT_ABI,
      functionName: 'diamondCut',
      args: [
        [{ facetAddress: FACET, action: 0, functionSelectors: selectors }],
        initCalldata === '0x' ? (ZERO_ADDRESS as Address) : DIAMOND,
        initCalldata,
      ],
    })

  it('reads a cut that installs PeripheryRegistryFacet without calling it unreadable', () => {
    // The facet's own selector list contains `registerPeripheryContract`,
    // byte-aligned by construction. `PeripheryRegistryFacet` is a core facet,
    // so scanning a cut the other reader had just decoded reported every
    // new-network onboarding as both read and unreadable.
    const { references, undecodable } = collectAddressReferences([
      cutCarrying([REGISTER_PERIPHERY_SELECTOR, '0xaabbccdd' as Hex], '0x'),
    ])

    expect(undecodable).toEqual([])
    expect(
      references.some(
        (reference) => reference.role === AddressRoleEnum.FacetAdd
      )
    ).toBe(true)
  })

  it('still reports a registration carried in a cut init calldata', () => {
    // The walk stops at the cut, so nothing opens its init calldata — the one
    // hiding place the blanket scan above used to cover.
    const { undecodable } = collectAddressReferences([
      cutCarrying(['0xaabbccdd' as Hex], register('Executor', PERIPHERY)),
    ])

    expect(undecodable).toEqual([
      'call[0].diamondCut[0].init (carries a registerPeripheryContract selector this could not read through)',
    ])
  })
})
