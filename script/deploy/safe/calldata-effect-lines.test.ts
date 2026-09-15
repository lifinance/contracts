/**
 * Tests for the zone-1 calldata effect block.
 *
 * Every case renders a real encoded payload rather than a hand-written line, so
 * the assertions are about what a signer would see. The hostile cases assert
 * both halves of the discipline the module claims: that a proposer-controlled
 * value never becomes syntax, and that nothing it stops printing goes unnamed.
 */

import {
  describe,
  expect,
  it,
  spyOn,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { consola } from 'consola'
import {
  encodeFunctionData,
  keccak256,
  parseAbi,
  stringToHex,
  zeroAddress,
} from 'viem'

import { buildCalldataEffectLines } from './calldata-effect-lines'

const NETWORK = 'arbitrum'
const INDENT = '      '
const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const FACET = '0xAD3F7cC5f0A5bC1Bce0f8E9ba0c8c9F6c1D4D6BC'

const ABI_DIAMOND_CUT = parseAbi([
  'function diamondCut((address,uint8,bytes4[])[],address,bytes)',
])
const ABI_SCHEDULE_BATCH = parseAbi([
  'function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
])
const ABI_REGISTER_PERIPHERY = parseAbi([
  'function registerPeripheryContract(string,address)',
])

const ZERO_WORD =
  '0x0000000000000000000000000000000000000000000000000000000000000000'

const SELECTORS = ['0xa1f1ce43', '0x1794958f'] as const

const diamondCut = (
  action: number,
  facet: `0x${string}` = FACET,
  selectors: readonly `0x${string}`[] = SELECTORS
): `0x${string}` =>
  encodeFunctionData({
    abi: ABI_DIAMOND_CUT,
    functionName: 'diamondCut',
    args: [[[facet, action, [...selectors]]], zeroAddress, '0x'],
  })

const scheduleBatch = (
  payload: `0x${string}`,
  delay: bigint,
  predecessor: `0x${string}` = ZERO_WORD
): `0x${string}` =>
  encodeFunctionData({
    abi: ABI_SCHEDULE_BATCH,
    functionName: 'scheduleBatch',
    args: [
      [DIAMOND],
      [0n],
      [payload],
      predecessor,
      '0x00000000000000000000000000000000000000000000000000000000000000aa',
      delay,
    ],
  })

const render = async (data: unknown, target: unknown = DIAMOND) =>
  buildCalldataEffectLines(data, {
    network: NETWORK,
    indent: INDENT,
    target,
  })

/** The lines with their colour codes removed, which is what a reader sees. */
const plain = (lines: string[]): string[] =>
  lines.map((line) =>
    line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu'), '')
  )

describe('buildCalldataEffectLines — the block is returned, not printed', () => {
  it('writes nothing to consola', async () => {
    const info = spyOn(consola, 'info').mockImplementation((() => {}) as never)
    const warn = spyOn(consola, 'warn').mockImplementation((() => {}) as never)
    const log = spyOn(consola, 'log').mockImplementation((() => {}) as never)
    try {
      const lines = await render(scheduleBatch(diamondCut(2), 10_800n))
      expect(lines.length).toBeGreaterThan(0)
      expect(info).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
    } finally {
      info.mockRestore()
      warn.mockRestore()
      log.mockRestore()
    }
  })

  it('indents every line to the block it is drawn in', async () => {
    const lines = await render(scheduleBatch(diamondCut(1), 10_800n))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line.startsWith(INDENT)).toBe(true)
  })

  it('draws no consola level prefix', async () => {
    const lines = plain(await render(scheduleBatch(diamondCut(1), 10_800n)))
    for (const line of lines) expect(line).not.toContain('ℹ')
  })

  it('draws no fixed-width rule that ignores the view', async () => {
    const lines = plain(await render(scheduleBatch(diamondCut(1), 10_800n)))
    for (const line of lines) expect(line).not.toContain('-'.repeat(20))
  })
})

describe('buildCalldataEffectLines — the summarised effect', () => {
  it('names the function and its selector before summarising it', async () => {
    const [first] = plain(await render(diamondCut(2, zeroAddress)))
    expect(first).toContain('diamondCut [0x1f931c1c] on ')
    expect(first).toContain(DIAMOND)
  })

  it('summarises a removal without naming a facet it is not cutting in', async () => {
    const lines = plain(await render(diamondCut(2, zeroAddress)))
    expect(lines.join('\n')).toContain('Remove 2 functions')
    expect(lines.join('\n')).not.toContain('→')
  })

  it('summarises an addition towards the facet it adds', async () => {
    const lines = plain(await render(diamondCut(0))).join('\n')
    expect(lines).toContain('Add 2 functions → ')
    expect(lines).toContain(FACET)
  })

  it('counts one function in the singular', async () => {
    const lines = plain(await render(diamondCut(1, FACET, ['0xa1f1ce43'])))
    expect(lines.join('\n')).toContain('Replace 1 function → ')
  })

  it('lists the selectors under the summary', async () => {
    const lines = plain(await render(diamondCut(1))).join('\n')
    for (const selector of SELECTORS) expect(lines).toContain(selector)
  })
})

describe('buildCalldataEffectLines — a proposer-controlled field is never syntax', () => {
  it('quotes a diamondCut action outside the closed set instead of reading it as a verb', async () => {
    const lines = plain(await render(diamondCut(7))).join('\n')
    expect(lines).toContain('action "7" on 2 functions → ')
    // Ungraded: naming what 7 is not is zone 2's verdict, not this section's.
    expect(lines).not.toContain('invalid')
    expect(lines).not.toContain('unknown action')
  })

  it('never lets a decoded action supply the verb', async () => {
    for (const action of [3, 7, 255]) {
      const lines = plain(await render(diamondCut(action))).join('\n')
      expect(lines).toContain(`action "${action}"`)
    }
  })

  it('quotes a periphery name and renders a hostile one inert', async () => {
    const hostile = `Fee[31mCollector`
    const lines = plain(
      await render(
        encodeFunctionData({
          abi: ABI_REGISTER_PERIPHERY,
          functionName: 'registerPeripheryContract',
          args: [hostile, FACET],
        })
      )
    ).join('\n')
    expect(lines).toContain('register periphery "')
    expect(lines).not.toContain('[31mCollector')
    expect(lines).toContain('sanitised')
  })
})

describe('buildCalldataEffectLines — what it declines to print', () => {
  it('prints no salt at all', async () => {
    // Per-proposal entropy that makes the operation id unique. A signer has
    // nothing to compare it to, and no value of it is wrong.
    const lines = plain(await render(scheduleBatch(diamondCut(1), 10_800n)))
    expect(lines.join('\n')).not.toContain('00000000000000aa')
  })

  it('says nothing about a zero predecessor', async () => {
    const lines = plain(await render(scheduleBatch(diamondCut(1), 10_800n)))
    expect(lines.join('\n')).not.toContain('predecessor')
    expect(lines.join('\n')).not.toContain('ordered behind')
  })

  it('prints a non-zero predecessor, which is the case that means something', async () => {
    const predecessor = `0x${'ab'.repeat(32)}` as `0x${string}`
    const lines = plain(
      await render(scheduleBatch(diamondCut(1), 10_800n, predecessor))
    ).join('\n')
    expect(lines).toContain('ordered behind operation')
    expect(lines).toContain(predecessor)
  })

  it('counts the selectors it holds back', async () => {
    const selectors = Array.from(
      { length: 30 },
      (_, i) => `0x${i.toString(16).padStart(8, '0')}` as `0x${string}`
    )
    const lines = plain(await render(diamondCut(1, FACET, selectors))).join(
      '\n'
    )
    expect(lines).toContain('further selectors not shown (30 in the calldata)')
  })
})

describe('buildCalldataEffectLines — the timelock envelope', () => {
  // The delay and the operation count left this line: the delay is read live
  // from the chain and refused by gate F, and the operation count is restated
  // by the indexed calls under it. Pinned as an absence so the clause cannot
  // drift back in unnoticed, with a present beside it — the envelope's own call
  // is still named.
  it('states the scheduling call without the delay or a count beside it', async () => {
    const lines = plain(
      await render(scheduleBatch(diamondCut(1), 10_800n))
    ).join('\n')

    expect(lines).toContain('scheduleBatch [')
    expect(lines).not.toContain('delay')
    expect(lines).not.toContain('10800')
    expect(lines).not.toContain('operation')
  })
})

describe('buildCalldataEffectLines — zone 1 reporting on its own output', () => {
  it('says so when the arguments will not decode', async () => {
    // A real `diamondCut` selector over a body no ABI can decode.
    const data = `${diamondCut(1).slice(0, 10)}${'11'.repeat(32)}`
    const lines = plain(await render(data)).join('\n')
    expect(lines).toContain('ARGUMENTS COULD NOT BE DECODED')
  })

  it('says so when the calldata is not hex at all', async () => {
    const lines = plain(await render('not calldata')).join('\n')
    expect(lines).toContain('CALLDATA COULD NOT BE DECODED')
  })

  it('quotes a name the selector registry resolved rather than vouching for it', async () => {
    // The registry answers this selector from a 4byte-style collision name, so
    // the call is named but nothing decodes its body.
    const lines = plain(await render('0xdeadbeef')).join('\n')
    expect(lines).toContain('[0xdeadbeef]')
    expect(lines).toContain('ARGUMENTS COULD NOT BE DECODED')
  })

  it('reports empty calldata as empty rather than as a failure', async () => {
    const lines = plain(await render('0x')).join('\n')
    expect(lines).toContain('no calldata')
    expect(lines).not.toContain('COULD NOT')
  })

  it('reports a target that is not an address as stored, with no link', async () => {
    const lines = plain(
      await render(diamondCut(2, zeroAddress), 'not-an-address')
    ).join('\n')
    expect(lines).toContain('not-an-address')
    expect(lines).toContain('not a valid address')
    expect(lines).not.toContain('http')
  })
})

describe('buildCalldataEffectLines — batches', () => {
  it('indexes the calls of a multi-call batch', async () => {
    const data = encodeFunctionData({
      abi: ABI_SCHEDULE_BATCH,
      functionName: 'scheduleBatch',
      args: [
        [DIAMOND, DIAMOND],
        [0n, 0n],
        [diamondCut(1), diamondCut(2, zeroAddress)],
        ZERO_WORD,
        ZERO_WORD,
        10_800n,
      ],
    })
    const lines = plain(await render(data)).join('\n')
    expect(lines).toContain('[00] ')
    expect(lines).toContain('[01] ')
  })

  it('does not index a single-call batch', async () => {
    const lines = plain(await render(scheduleBatch(diamondCut(1), 10_800n)))
    expect(lines.join('\n')).not.toContain('[00]')
  })
})

describe('buildCalldataEffectLines — the remaining known calls', () => {
  const ABI_WHITELIST = parseAbi([
    'function batchSetContractSelectorWhitelist(address[],bytes4[],bool)',
  ])
  const ABI_ROLE = parseAbi([
    'function grantRole(bytes32,address)',
    'function revokeRole(bytes32,address)',
  ])
  const ABI_SCHEDULE = parseAbi([
    'function schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
  ])

  it('names the whitelist verb from the decoded bool, both ways', async () => {
    for (const [whitelisted, verb] of [
      [true, 'Whitelist '],
      [false, 'Un-whitelist '],
    ] as const) {
      const lines = plain(
        await render(
          encodeFunctionData({
            abi: ABI_WHITELIST,
            functionName: 'batchSetContractSelectorWhitelist',
            args: [[FACET], ['0xa1f1ce43'], whitelisted],
          })
        )
      ).join('\n')
      expect(lines).toContain(`${verb}1 contract/selector pair`)
      expect(lines).toContain('0xa1f1ce43')
    }
  })

  it('names a known role and quotes the account it moves to', async () => {
    const proposerRole = keccak256(stringToHex('PROPOSER_ROLE'))
    const lines = plain(
      await render(
        encodeFunctionData({
          abi: ABI_ROLE,
          functionName: 'grantRole',
          args: [proposerRole, FACET],
        })
      )
    ).join('\n')
    expect(lines).toContain('grant role PROPOSER_ROLE → ')
    expect(lines).toContain(FACET)
  })

  it('shows the hash for a role this repository cannot name', async () => {
    const unknownRole = `0x${'cd'.repeat(32)}` as `0x${string}`
    const lines = plain(
      await render(
        encodeFunctionData({
          abi: ABI_ROLE,
          functionName: 'revokeRole',
          args: [unknownRole, FACET],
        })
      )
    ).join('\n')
    expect(lines).toContain('revoke role ')
    expect(lines).toContain(unknownRole)
  })

  it('renders a single-call schedule like a one-call batch', async () => {
    const lines = plain(
      await render(
        encodeFunctionData({
          abi: ABI_SCHEDULE,
          functionName: 'schedule',
          args: [DIAMOND, 0n, diamondCut(1), ZERO_WORD, ZERO_WORD, 10_800n],
        })
      )
    ).join('\n')
    expect(lines).toContain('schedule [')
    expect(lines).toContain('Replace 2 functions → ')
  })

  it('states a non-zero call value instead of collapsing it', async () => {
    const lines = plain(
      await render(
        encodeFunctionData({
          abi: ABI_SCHEDULE,
          functionName: 'schedule',
          args: [DIAMOND, 7n, diamondCut(1), ZERO_WORD, ZERO_WORD, 10_800n],
        })
      )
    )
    expect(lines.join('\n')).toContain('value 7')
  })

  it('decodes the init call a diamondCut carries', async () => {
    const init = encodeFunctionData({
      abi: ABI_REGISTER_PERIPHERY,
      functionName: 'registerPeripheryContract',
      args: ['FeeCollector', FACET],
    })
    const lines = plain(
      await render(
        encodeFunctionData({
          abi: ABI_DIAMOND_CUT,
          functionName: 'diamondCut',
          args: [[[FACET, 0, [...SELECTORS]]], DIAMOND, init],
        })
      )
    ).join('\n')
    expect(lines).toContain('then calls ')
    expect(lines).toContain('register periphery "FeeCollector"')
  })

  it('lists the arguments of a call it has no special rendering for', async () => {
    const lines = plain(
      await render(
        encodeFunctionData({
          abi: parseAbi(['function setOwner(address)']),
          functionName: 'setOwner',
          args: [FACET],
        })
      )
    ).join('\n')
    expect(lines).toContain('setOwner [')
    expect(lines).toContain('[0]: ')
    expect(lines).toContain(FACET)
  })
})
