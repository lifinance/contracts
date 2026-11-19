/**
 * What the confirm-time integrity assertions decide, driven directly.
 *
 * `confirm-safe-tx.ts` cannot be imported — it calls `runMain` at module scope
 * and exports nothing — and must never be spawned, because it signs and
 * broadcasts. So the decision is driven here against injected lookups, and
 * where the refusal *sits* inside that script is asserted on its source in
 * `confirm-integrity-asserts-placement.test.ts`.
 *
 * Every assertion is exercised in both directions: the clean proposal it must
 * let through, and the specific tamper it must block. The clean case is not
 * decoration — an assertion that refuses everything passes every red test.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  encodeFunctionData,
  getAddress,
  hashMessage,
  hashTypedData,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import {
  PINNED_CODEHASHES_REPO_PATH,
  parsePinnedCodehashes,
  pinnedKey,
} from '../codehash/pinned-codehashes'

import type { ICheckLedger, ILedgerVerdict } from './check-ledger'
import { proposalKeyOf } from './codehash-sign-gate'
import { createPinnedCodehashSource } from './codehash-sign-gate-deps'
import {
  CHECK_FIXED_FIELDS,
  CHECK_SAFE_ADDRESS,
  CHECK_SAFE_TX_HASH,
  CHECK_SIGNATURES,
  CHECK_TARGET,
  CHECK_TIMELOCK_DELAY,
  assertIntegrityAssertsAllowSigning,
  createIntegrityAssertDeps,
  readScheduleDelay,
  renderIntegrityAsserts,
  resolveRecordedTarget,
  runIntegrityAsserts,
  type IIntegrityAssertDeps,
  type IIntegrityAssertInput,
  type IIntegrityAssertRun,
} from './confirm-integrity-asserts'
import type { PinnedJsonRead } from './pinned-target-state'
import type { ISafeTransaction, SafeClient } from './safe-utils'
import {
  TIMELOCK_SCHEDULE_ABI,
  TIMELOCK_SCHEDULE_BATCH_ABI,
} from './timelock-abi'

const OWNER_KEY =
  // pre-commit-checker: not a secret
  '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex
const SECOND_OWNER_KEY =
  // pre-commit-checker: not a secret
  '0x2222222222222222222222222222222222222222222222222222222222222222' as Hex
const STRANGER_KEY =
  // pre-commit-checker: not a secret
  '0x3333333333333333333333333333333333333333333333333333333333333333' as Hex

const OWNER = privateKeyToAccount(OWNER_KEY).address
const SECOND_OWNER = privateKeyToAccount(SECOND_OWNER_KEY).address
const STRANGER = privateKeyToAccount(STRANGER_KEY).address

const SAFE = getAddress('0x00000000000000000000000000000000000000a1')
const OTHER_SAFE = getAddress('0x00000000000000000000000000000000000000a2')
const DIAMOND = getAddress('0x00000000000000000000000000000000000000d1')
const TIMELOCK = getAddress('0x00000000000000000000000000000000000000e1')
const UNKNOWN_TARGET = getAddress('0x00000000000000000000000000000000000000bb')

const REAL_HASH =
  // pre-commit-checker: not a secret
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex
const TAMPERED_HASH =
  // pre-commit-checker: not a secret
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex

const ZERO = '0x0000000000000000000000000000000000000000'
const NETWORK = 'mainnet'
const CHAIN_ID = 1
const NONCE = 7

/** A plain diamond-cut-free payload: not a schedule, so no delay check applies. */
const PLAIN_PAYLOAD = encodeFunctionData({
  abi: parseAbi(['function transferOwnership(address newOwner)']),
  args: [OWNER],
})

/** An owner rotation, which the Safe addresses to itself. */
const OWNER_ROTATION_PAYLOAD = encodeFunctionData({
  abi: parseAbi([
    'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  ]),
  args: [SECOND_OWNER, 2n],
})

const MIN_DELAY = 86400n

const scheduleBatchPayload = (delay: bigint): Hex =>
  encodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    args: [
      [DIAMOND],
      [0n],
      [PLAIN_PAYLOAD],
      `0x${'00'.repeat(32)}` as Hex,
      `0x${'11'.repeat(32)}` as Hex,
      delay,
    ],
  })

const committedLog = (): ReadonlyMap<string, string> =>
  new Map([
    [DIAMOND.toLowerCase(), 'LiFiDiamond'],
    [TIMELOCK.toLowerCase(), 'LiFiTimelockController'],
  ])

const makeInput = (
  over: Partial<IIntegrityAssertInput> = {}
): IIntegrityAssertInput => ({
  network: NETWORK,
  chainId: CHAIN_ID,
  clientSafeAddress: SAFE,
  configuredSafeAddress: SAFE,
  documentSafeAddress: SAFE,
  documentSafeTxHash: REAL_HASH,
  storedTxData: {
    to: DIAMOND,
    value: '0',
    data: PLAIN_PAYLOAD,
    operation: 0,
    nonce: NONCE,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: ZERO,
    refundReceiver: ZERO,
  },
  storedSignatures: [],
  to: DIAMOND,
  data: PLAIN_PAYLOAD,
  signedValue: '0',
  signedOperation: 0,
  signedNonce: NONCE,
  ...over,
})

const makeDeps = (
  over: Partial<IIntegrityAssertDeps> = {}
): IIntegrityAssertDeps => ({
  recomputeSafeTxHash: async () => REAL_HASH,
  currentOwners: async () => [OWNER, SECOND_OWNER] as readonly Address[],
  committedDeployments: async () => committedLog(),
  recordedDeployments: async () => [],
  pinnedCodehash: async () => undefined,
  liveCodehash: async () => {
    throw new Error('the chain is read only for a pinned target')
  },
  timelockMinDelay: async () => MIN_DELAY,
  ...over,
})

/** An `eth_sign` signature, which the Safe recovers over the EIP-191 digest at `v - 4`. */
const ethSignSignature = async (
  privateKey: Hex,
  safeTxHash: Hex
): Promise<Hex> => {
  const raw = await privateKeyToAccount(privateKey).sign({
    hash: hashMessage({ raw: safeTxHash }),
  })
  const v = parseInt(raw.slice(130, 132), 16)
  return `${raw.slice(0, 130)}${(v + 4).toString(16).padStart(2, '0')}` as Hex
}

/**
 * An EIP-712 signature over the Safe struct.
 *
 * The struct is restated here rather than imported from the module under test:
 * a digest built by the same code it verifies would agree with itself no matter
 * which field either side got wrong.
 */
const typedDataSignature = async (
  privateKey: Hex,
  input: IIntegrityAssertInput
): Promise<Hex> => {
  const digest = hashTypedData({
    domain: {
      chainId: input.chainId,
      verifyingContract: input.clientSafeAddress,
    },
    types: {
      SafeTx: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' },
        { name: 'safeTxGas', type: 'uint256' },
        { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'gasToken', type: 'address' },
        { name: 'refundReceiver', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'SafeTx',
    message: {
      to: getAddress(input.to),
      value: BigInt(input.signedValue),
      data: input.data,
      operation: input.signedOperation,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce: BigInt(input.signedNonce),
    },
  })
  return privateKeyToAccount(privateKey).sign({ hash: digest })
}

/** One check's recorded status, so a test names the check it is about. */
const statusOf = async (
  input: IIntegrityAssertInput,
  deps: IIntegrityAssertDeps,
  checkId: string
): Promise<{ status: string; actual: string; anchor: string }> => {
  const run = await runIntegrityAsserts(input, deps)
  const results = [...run.ledger.results.values()].filter(
    (result) => result.checkId === checkId
  )
  expect(results).toHaveLength(1)
  const only = results[0]
  if (!only) throw new Error(`no result recorded for ${checkId}`)
  return { status: only.status, actual: only.actual, anchor: only.anchor }
}

describe('the Safe the proposal is against', () => {
  it('passes when the document names the Safe config names, in any case', async () => {
    const outcome = await statusOf(
      makeInput({ documentSafeAddress: SAFE.toLowerCase() }),
      makeDeps(),
      CHECK_SAFE_ADDRESS
    )
    expect(outcome.status).toBe('pass')
    expect(outcome.anchor).toBe('A-LOCAL')
  })

  it('fails when the document names a different Safe', async () => {
    const outcome = await statusOf(
      makeInput({ documentSafeAddress: OTHER_SAFE }),
      makeDeps(),
      CHECK_SAFE_ADDRESS
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toBe(OTHER_SAFE)
  })

  it('is unverified — not a pass — when config names no Safe at all', async () => {
    const input = makeInput()
    delete (input as { configuredSafeAddress?: string }).configuredSafeAddress
    const outcome = await statusOf(input, makeDeps(), CHECK_SAFE_ADDRESS)
    expect(outcome.status).toBe('error')
    expect(outcome.anchor).toBe('A-UNRESOLVED')
  })

  it('is unverified when the document names no Safe to compare', async () => {
    const outcome = await statusOf(
      makeInput({ documentSafeAddress: '   ' }),
      makeDeps(),
      CHECK_SAFE_ADDRESS
    )
    expect(outcome.status).toBe('error')
  })
})

describe('the recomputed safeTxHash against the stored one', () => {
  it('passes when they agree', async () => {
    const outcome = await statusOf(makeInput(), makeDeps(), CHECK_SAFE_TX_HASH)
    expect(outcome.status).toBe('pass')
    expect(outcome.anchor).toBe('A-CHAIN')
  })

  it('fails on a tampered stored hash', async () => {
    const outcome = await statusOf(
      makeInput({ documentSafeTxHash: TAMPERED_HASH }),
      makeDeps(),
      CHECK_SAFE_TX_HASH
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toBe(TAMPERED_HASH)
  })

  it('is unverified when the stored value is not a 32-byte hash', async () => {
    const outcome = await statusOf(
      makeInput({ documentSafeTxHash: '0xdeadbeef' }),
      makeDeps(),
      CHECK_SAFE_TX_HASH
    )
    expect(outcome.status).toBe('error')
  })

  it('is unverified when the Safe could not be asked', async () => {
    const outcome = await statusOf(
      makeInput(),
      makeDeps({
        recomputeSafeTxHash: async () => {
          throw new Error('rpc down')
        },
      }),
      CHECK_SAFE_TX_HASH
    )
    expect(outcome.status).toBe('error')
    expect(outcome.actual).toBe(REAL_HASH)
  })
})

describe('stored signatures against the current owner set', () => {
  it('accepts an eth_sign signature from a current owner', async () => {
    const input = makeInput()
    const outcome = await statusOf(
      makeInput({
        storedSignatures: [
          {
            signer: OWNER,
            data: await ethSignSignature(OWNER_KEY, REAL_HASH),
          },
        ],
      }),
      makeDeps(),
      CHECK_SIGNATURES
    )
    expect(input.storedSignatures).toHaveLength(0)
    expect(outcome.status).toBe('pass')
    expect(outcome.actual).toContain('1 of 1')
  })

  it('accepts an EIP-712 signature from a current owner', async () => {
    const input = makeInput()
    const outcome = await statusOf(
      makeInput({
        storedSignatures: [
          { signer: OWNER, data: await typedDataSignature(OWNER_KEY, input) },
        ],
      }),
      makeDeps(),
      CHECK_SIGNATURES
    )
    expect(outcome.status).toBe('pass')
  })

  it('fails on a signature from someone who is not an owner', async () => {
    const outcome = await statusOf(
      makeInput({
        storedSignatures: [
          {
            signer: STRANGER,
            data: await ethSignSignature(STRANGER_KEY, REAL_HASH),
          },
        ],
      }),
      makeDeps(),
      CHECK_SIGNATURES
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toContain(STRANGER)
    expect(outcome.actual).toContain('not a current owner')
  })

  it('fails when the stored signer label disagrees with the recovery', async () => {
    const outcome = await statusOf(
      makeInput({
        storedSignatures: [
          {
            signer: SECOND_OWNER,
            data: await ethSignSignature(OWNER_KEY, REAL_HASH),
          },
        ],
      }),
      makeDeps(),
      CHECK_SIGNATURES
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toContain('recovers to')
  })

  it('recovers against the recomputed hash, never the stored one', async () => {
    // A signature over the hash the proposer stored. If the check keyed on that
    // stored value it would verify — which is the whole substitution this
    // assertion exists to catch.
    const outcome = await statusOf(
      makeInput({
        documentSafeTxHash: TAMPERED_HASH,
        storedSignatures: [
          {
            signer: OWNER,
            data: await ethSignSignature(OWNER_KEY, TAMPERED_HASH),
          },
        ],
      }),
      makeDeps(),
      CHECK_SIGNATURES
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toContain('not a current owner')
  })

  it('reports an unrecoverable v rather than a signature belonging to nobody', async () => {
    const real = await ethSignSignature(OWNER_KEY, REAL_HASH)
    const outcome = await statusOf(
      makeInput({
        storedSignatures: [{ signer: OWNER, data: `${real.slice(0, 130)}05` }],
      }),
      makeDeps(),
      CHECK_SIGNATURES
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toContain('v=5')
  })

  it('reports a struct it cannot reframe as typed data rather than throwing', async () => {
    const real = await ethSignSignature(OWNER_KEY, REAL_HASH)
    const outcome = await statusOf(
      makeInput({
        to: 'not-an-address',
        storedSignatures: [{ signer: OWNER, data: `${real.slice(0, 130)}1b` }],
      }),
      makeDeps(),
      CHECK_SIGNATURES
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toContain('could not be reframed as typed data')
  })

  it('reports a signature it cannot recover rather than throwing', async () => {
    // An out-of-range `r`/`s` on an otherwise well-formed eth_sign signature:
    // `recoverAddress` throws on this, and the throw would escape under no
    // anchor instead of naming this check.
    const outcome = await statusOf(
      makeInput({
        storedSignatures: [{ signer: OWNER, data: `0x${'0'.repeat(128)}1f` }],
      }),
      makeDeps(),
      CHECK_SIGNATURES
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toContain('could not be recovered')
  })

  it('is unverified when the owner set could not be read', async () => {
    const outcome = await statusOf(
      makeInput({
        storedSignatures: [
          { signer: OWNER, data: await ethSignSignature(OWNER_KEY, REAL_HASH) },
        ],
      }),
      makeDeps({
        currentOwners: async () => {
          throw new Error('rpc down')
        },
      }),
      CHECK_SIGNATURES
    )
    expect(outcome.status).toBe('error')
  })

  it('refuses a proposal whose stored signature set is empty', async () => {
    const outcome = await statusOf(makeInput(), makeDeps(), CHECK_SIGNATURES)
    // `fail`, not `error`: the check ran and found a real mismatch, and
    // `error` is reserved for a check that could not run at all.
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toBe('0 stored signatures')
    expect(outcome.anchor).toBe('A-PROPOSAL')
  })
})

describe('the fields the hash covers, and the ones it omits', () => {
  it('passes a Call whose omitted fields are all zero', async () => {
    const outcome = await statusOf(makeInput(), makeDeps(), CHECK_FIXED_FIELDS)
    expect(outcome.status).toBe('pass')
  })

  it('fails when the struct being signed is a delegatecall', async () => {
    const outcome = await statusOf(
      makeInput({ signedOperation: 1, storedTxData: { operation: 1 } }),
      makeDeps(),
      CHECK_FIXED_FIELDS
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toContain('operation=1')
  })

  it('pins the required operation as a value, so renumbering cannot admit a 1', async () => {
    // 2 is not `Call` under any numbering, and an assertion written against a
    // symbol would move with the enum and let this through.
    const outcome = await statusOf(
      makeInput({ signedOperation: 2, storedTxData: { operation: 2 } }),
      makeDeps(),
      CHECK_FIXED_FIELDS
    )
    expect(outcome.status).toBe('fail')
  })

  it('fails when the stored row disagrees with the struct being signed', async () => {
    const outcome = await statusOf(
      makeInput({ signedOperation: 0, storedTxData: { operation: 1 } }),
      makeDeps(),
      CHECK_FIXED_FIELDS
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toContain('the stored row says operation=1')
  })

  it('accepts a row that omits operation, which is normalised to Call', async () => {
    const outcome = await statusOf(
      makeInput({ storedTxData: { to: DIAMOND, value: '0' } }),
      makeDeps(),
      CHECK_FIXED_FIELDS
    )
    expect(outcome.status).toBe('pass')
  })

  it('refuses a stored operation that is present but not readable as an integer', async () => {
    // `Number('')` is 0, so a coercion would read this as agreeing with Call.
    const outcome = await statusOf(
      makeInput({ storedTxData: { operation: '' } }),
      makeDeps(),
      CHECK_FIXED_FIELDS
    )
    expect(outcome.status).toBe('fail')
  })

  it('fails on a non-zero field the hash does not cover', async () => {
    const outcome = await statusOf(
      makeInput({ storedTxData: { operation: 0, safeTxGas: '1' } }),
      makeDeps(),
      CHECK_FIXED_FIELDS
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toContain('safeTxGas=1')
  })

  it('fails on a non-zero refundReceiver', async () => {
    const outcome = await statusOf(
      makeInput({ storedTxData: { operation: 0, refundReceiver: STRANGER } }),
      makeDeps(),
      CHECK_FIXED_FIELDS
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toContain('refundReceiver=')
  })

  it('fails on a field outside the signed struct entirely', async () => {
    const outcome = await statusOf(
      makeInput({ storedTxData: { operation: 0, displayNote: 'looks fine' } }),
      makeDeps(),
      CHECK_FIXED_FIELDS
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toContain('displayNote')
  })
})

describe('the target', () => {
  it('passes the configured Safe itself — an owner rotation is addressed there', async () => {
    const outcome = await statusOf(
      makeInput({ to: SAFE, data: OWNER_ROTATION_PAYLOAD }),
      makeDeps(),
      CHECK_TARGET
    )
    expect(outcome.status).toBe('pass')
    expect(outcome.actual).toContain('the configured Safe itself')
  })

  it('passes an address the committed deployment log names', async () => {
    const outcome = await statusOf(makeInput(), makeDeps(), CHECK_TARGET)
    expect(outcome.status).toBe('pass')
    expect(outcome.actual).toContain('LiFiDiamond')
  })

  it('fails on a target neither the log nor the record names', async () => {
    const outcome = await statusOf(
      makeInput({ to: UNKNOWN_TARGET, storedTxData: { operation: 0 } }),
      makeDeps(),
      CHECK_TARGET
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toContain('named by neither')
  })

  it('never decides a pass from the deployment record alone', async () => {
    // A-MONGO reports; the ledger downgrades a pass recorded against it, so a
    // target only the deployment record names does not authorise a signature.
    const outcome = await statusOf(
      makeInput({ to: UNKNOWN_TARGET }),
      makeDeps({
        recordedDeployments: async () => [
          { contractName: 'GasZipFacet', version: '2.0.0' },
        ],
      }),
      CHECK_TARGET
    )
    expect(outcome.status).toBe('error')
    expect(outcome.anchor).toBe('A-MONGO')
  })

  it('fails when the deployment record contradicts itself', async () => {
    const outcome = await statusOf(
      makeInput({ to: UNKNOWN_TARGET }),
      makeDeps({
        recordedDeployments: async () => [
          { contractName: 'GasZipFacet', version: '2.0.0' },
          { contractName: 'GasZipFacet', version: '2.0.1' },
        ],
      }),
      CHECK_TARGET
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toContain('contradicts itself')
  })

  it('is unverified when the committed log could not be read', async () => {
    const outcome = await statusOf(
      makeInput(),
      makeDeps({
        committedDeployments: async () => {
          throw new Error('no artefacts')
        },
      }),
      CHECK_TARGET
    )
    expect(outcome.status).toBe('error')
  })
})

describe('a target main pins the codehash of', () => {
  const EXTERNAL = getAddress('0xd0D4d0c8a03029cb434868CaDc81c9500A7f0468')
  const PINNED_HASH = `0x${'d1'.repeat(32)}` as Hex
  const OTHER_HASH = `0x${'ee'.repeat(32)}` as Hex
  const HANDOVER: Hex = '0x25692962'
  const PIN = { codehash: PINNED_HASH, label: 'IntentExecutor on mainnet' }

  const externalInput = (): IIntegrityAssertInput =>
    makeInput({
      to: EXTERNAL,
      data: HANDOVER,
      storedTxData: { to: EXTERNAL, data: HANDOVER, operation: 0 },
    })

  const pinnedDeps = (
    over: Partial<IIntegrityAssertDeps> = {}
  ): IIntegrityAssertDeps =>
    makeDeps({
      pinnedCodehash: async (address) =>
        address === EXTERNAL ? PIN : undefined,
      liveCodehash: async () => PINNED_HASH,
      ...over,
    })

  it('passes on the chain anchor when the deployed code matches the pin', async () => {
    const outcome = await statusOf(externalInput(), pinnedDeps(), CHECK_TARGET)
    expect(outcome.status).toBe('pass')
    expect(outcome.anchor).toBe('A-CHAIN')
    expect(outcome.actual).toContain('IntentExecutor on mainnet')
  })

  it('compares the hashes in any case', async () => {
    const outcome = await statusOf(
      externalInput(),
      pinnedDeps({
        liveCodehash: async () => PINNED_HASH.toUpperCase() as Hex,
      }),
      CHECK_TARGET
    )
    expect(outcome.status).toBe('pass')
  })

  it('fails when the deployed code differs from the pin', async () => {
    const outcome = await statusOf(
      externalInput(),
      pinnedDeps({ liveCodehash: async () => OTHER_HASH }),
      CHECK_TARGET
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.anchor).toBe('A-CHAIN')
    expect(outcome.actual).toContain(OTHER_HASH)
    expect(outcome.actual).toContain('IntentExecutor on mainnet')
  })

  it('does not let the deployment record rescue a codehash mismatch', async () => {
    const outcome = await statusOf(
      externalInput(),
      pinnedDeps({
        liveCodehash: async () => OTHER_HASH,
        recordedDeployments: async () => [
          { contractName: 'IntentExecutor', version: '1.0.0' },
        ],
      }),
      CHECK_TARGET
    )
    expect(outcome.status).toBe('fail')
  })

  it('is unverified, never passed, when the pins cannot be read', async () => {
    const outcome = await statusOf(
      externalInput(),
      pinnedDeps({
        pinnedCodehash: async () => {
          throw new Error('fetch failed')
        },
      }),
      CHECK_TARGET
    )
    expect(outcome.status).toBe('error')
    expect(outcome.anchor).toBe('A-UNRESOLVED')
  })

  it('is unverified when the deployed code cannot be read', async () => {
    const outcome = await statusOf(
      externalInput(),
      pinnedDeps({
        liveCodehash: async () => {
          throw new Error('rpc down')
        },
      }),
      CHECK_TARGET
    )
    expect(outcome.status).toBe('error')
    expect(outcome.anchor).toBe('A-UNRESOLVED')
  })

  it('keeps the RPC endpoint out of the record when the code read fails', async () => {
    const run = await runIntegrityAsserts(
      externalInput(),
      pinnedDeps({
        liveCodehash: async () => {
          throw new Error(
            'HTTP request failed. URL: https://rpc.example/v2/secret-key'
          )
        },
      })
    )
    const recorded = JSON.stringify([...run.ledger.results.values()])
    expect(recorded).not.toContain('secret-key')
    expect(recorded).toContain('[redacted-url]')
  })

  it('decides before the deployment record is consulted', async () => {
    let consulted = false
    const outcome = await statusOf(
      externalInput(),
      pinnedDeps({
        recordedDeployments: async () => {
          consulted = true
          return []
        },
      }),
      CHECK_TARGET
    )
    expect(outcome.status).toBe('pass')
    expect(consulted).toBe(false)
  })

  it('leaves the refusal unchanged for a target nothing pins', async () => {
    const outcome = await statusOf(
      makeInput({ to: UNKNOWN_TARGET, storedTxData: { operation: 0 } }),
      pinnedDeps(),
      CHECK_TARGET
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.anchor).toBe('A-LOCAL')
    expect(outcome.actual).toContain('named by neither')
  })

  it('does not consult the pins for the configured Safe or a committed address', async () => {
    const unreachable = pinnedDeps({
      pinnedCodehash: async () => {
        throw new Error('pins must not be read')
      },
    })
    const safe = await statusOf(
      makeInput({ to: SAFE, data: OWNER_ROTATION_PAYLOAD }),
      unreachable,
      CHECK_TARGET
    )
    const committed = await statusOf(makeInput(), unreachable, CHECK_TARGET)
    expect(safe.status).toBe('pass')
    expect(safe.anchor).toBe('A-LOCAL')
    expect(committed.status).toBe('pass')
    expect(committed.actual).toContain('LiFiDiamond')
  })
})

describe('createIntegrityAssertDeps pin wiring', () => {
  const EXTERNAL = getAddress('0xd0D4d0c8a03029cb434868CaDc81c9500A7f0468')
  const RUNTIME = '0x6080604052' as Hex
  const committedFile = JSON.parse(
    readFileSync(PINNED_CODEHASHES_REPO_PATH, 'utf8')
  ) as Record<string, unknown>

  const fakeSafe = (code: Hex | undefined): SafeClient =>
    ({
      getPublicClient: () => ({
        getCode: async ({ address }: { address: Address }) =>
          address === EXTERNAL ? code : undefined,
      }),
    }) as unknown as SafeClient

  // The committed log and the deployment record are replaced with offline
  // answers, so an error or a refusal below can only have come from the pins.
  const depsWith = (
    readPinnedBlob: (repoPath: string) => Promise<PinnedJsonRead>,
    safe: SafeClient = fakeSafe(RUNTIME)
  ): IIntegrityAssertDeps => ({
    ...createIntegrityAssertDeps({
      network: 'Mainnet',
      safe,
      safeTx: {} as ISafeTransaction,
      pinnedCodehashFor: createPinnedCodehashSource(readPinnedBlob),
    }),
    committedDeployments: async () => committedLog(),
    recordedDeployments: async () => [],
  })

  it('hashes the live runtime code and looks the pin up under the network', async () => {
    const asked: string[] = []
    const deps = depsWith(async (repoPath) => {
      asked.push(repoPath)
      return {
        ok: true,
        value: {
          IntentExecutor: {
            source: 'example',
            deployments: {
              mainnet: { address: EXTERNAL, codehash: keccak256(RUNTIME) },
            },
          },
        },
      }
    })

    expect(await deps.liveCodehash(EXTERNAL)).toBe(keccak256(RUNTIME))
    expect(await deps.pinnedCodehash(EXTERNAL)).toEqual({
      codehash: keccak256(RUNTIME),
      label: 'IntentExecutor on mainnet',
    })
    expect(asked).toEqual([PINNED_CODEHASHES_REPO_PATH])
  })

  it('hashes an address with no code as the empty string', async () => {
    const deps = depsWith(
      async () => ({ ok: true, value: {} }),
      fakeSafe(undefined)
    )
    expect(await deps.liveCodehash(EXTERNAL)).toBe(keccak256('0x'))
  })

  it('reads pins only from main, so a pin the checkout adds is ignored', async () => {
    // The checkout's own file pins this address; main's copy does not.
    expect(
      parsePinnedCodehashes(committedFile).has(pinnedKey('mainnet', EXTERNAL))
    ).toBe(true)
    const outcome = await statusOf(
      makeInput({
        to: EXTERNAL,
        data: '0x25692962',
        storedTxData: { operation: 0 },
      }),
      depsWith(async () => ({ ok: true, value: {} })),
      CHECK_TARGET
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toContain('named by neither')
  })

  it.each(['fetch-failed', 'invalid-shape'] as const)(
    'is unverified, not refused as unpinned, when main cannot be read (%s)',
    async (reason) => {
      const outcome = await statusOf(
        makeInput({ to: EXTERNAL, storedTxData: { operation: 0 } }),
        depsWith(async () => ({ ok: false, reason })),
        CHECK_TARGET
      )
      expect(outcome.status).toBe('error')
      expect(outcome.anchor).toBe('A-UNRESOLVED')
    }
  )

  it('is unverified when main carries a malformed pin file', async () => {
    const outcome = await statusOf(
      makeInput({ to: EXTERNAL, storedTxData: { operation: 0 } }),
      depsWith(async () => ({
        ok: true,
        value: { IntentExecutor: { deployments: {} } },
      })),
      CHECK_TARGET
    )
    expect(outcome.status).toBe('error')
    expect(outcome.anchor).toBe('A-UNRESOLVED')
  })

  it.each([
    ['production', '0xd0D4d0c8a03029cb434868CaDc81c9500A7f0468'],
    ['dev', '0xD6552aF70ffa577166d98d120137D4Ad4d8d821d'],
  ])(
    'the committed file pins the %s IntentExecutor on every network the Safe calls it on',
    (_, address) => {
      const pins = parsePinnedCodehashes(committedFile)
      for (const network of INTENT_EXECUTOR_NETWORKS)
        expect(pins.get(pinnedKey(network, address))?.codehash).toBe(
          '0xd1e30761de57afee679b565abce89cc01950914d7aa8d823373e83dead77c421'
        )
    }
  )
})

const INTENT_EXECUTOR_NETWORKS = [
  'mainnet',
  'optimism',
  'bsc',
  'polygon',
  'hyperevm',
  'pharos',
  'tempo',
  'robinhood',
  'arc',
  'base',
  'plasma',
  'arbitrum',
  'avalanche',
] as const

describe('resolveRecordedTarget', () => {
  it('names a single versioned record', () => {
    expect(
      resolveRecordedTarget([{ contractName: 'GasZipFacet', version: '2.0.0' }])
    ).toEqual({
      kind: 'recorded-deployment',
      name: 'GasZipFacet',
      version: '2.0.0',
    })
  })

  it('treats a blank version as no disagreement', () => {
    expect(
      resolveRecordedTarget([
        { contractName: 'GasZipFacet', version: '' },
        { contractName: 'GasZipFacet', version: '2.0.0' },
      ])
    ).toEqual({
      kind: 'recorded-deployment',
      name: 'GasZipFacet',
      version: '2.0.0',
    })
  })

  it('reports two different answers as ambiguous', () => {
    const resolution = resolveRecordedTarget([
      { contractName: 'GasZipFacet', version: '2.0.0' },
      { contractName: 'PatcherFacet', version: '1.0.0' },
    ])
    expect(resolution.kind).toBe('ambiguous')
  })

  it('collapses one version padded two ways', () => {
    // Blankness was judged trimmed while the identity key used the raw string,
    // so one deploy padded two ways read as two candidates and refused.
    const resolution = resolveRecordedTarget([
      { contractName: 'GasZipFacet', version: '2.0.0' },
      { contractName: 'GasZipFacet', version: ' 2.0.0 ' },
    ])

    expect(resolution).toEqual({
      kind: 'recorded-deployment',
      name: 'GasZipFacet',
      version: '2.0.0',
    })
  })

  it('reports nothing at all as unknown', () => {
    expect(resolveRecordedTarget([])).toEqual({ kind: 'unknown' })
  })
})

describe('the timelock delay', () => {
  it('is not registered for a payload that is not a schedule', async () => {
    const run = await runIntegrityAsserts(makeInput(), makeDeps())
    expect(run.registered).not.toContain(CHECK_TIMELOCK_DELAY)
    // Paired positive: the other five are registered, so "not contained" is not
    // passing against an empty list.
    expect(run.registered).toContain(CHECK_TARGET)
    expect(run.registered).toHaveLength(5)
  })

  it('passes a schedule at exactly the live minimum', async () => {
    const data = scheduleBatchPayload(MIN_DELAY)
    const outcome = await statusOf(
      makeInput({ to: TIMELOCK, data, storedTxData: { operation: 0 } }),
      makeDeps(),
      CHECK_TIMELOCK_DELAY
    )
    expect(outcome.status).toBe('pass')
    expect(outcome.anchor).toBe('A-CHAIN')
  })

  it('fails a schedule one second short of the live minimum', async () => {
    const data = scheduleBatchPayload(MIN_DELAY - 1n)
    const outcome = await statusOf(
      makeInput({ to: TIMELOCK, data, storedTxData: { operation: 0 } }),
      makeDeps(),
      CHECK_TIMELOCK_DELAY
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toBe(`${MIN_DELAY - 1n} seconds`)
  })

  it('reads the singular schedule as well as the batch form', () => {
    const data = encodeFunctionData({
      abi: TIMELOCK_SCHEDULE_ABI,
      args: [
        DIAMOND,
        0n,
        PLAIN_PAYLOAD,
        `0x${'00'.repeat(32)}` as Hex,
        `0x${'11'.repeat(32)}` as Hex,
        99n,
      ],
    })
    expect(readScheduleDelay(data)).toEqual({ kind: 'schedule', delay: 99n })
  })

  it('fails a schedule addressed somewhere other than the committed timelock', async () => {
    const data = scheduleBatchPayload(MIN_DELAY)
    const outcome = await statusOf(
      makeInput({ to: DIAMOND, data, storedTxData: { operation: 0 } }),
      makeDeps(),
      CHECK_TIMELOCK_DELAY
    )
    expect(outcome.status).toBe('fail')
    expect(outcome.actual).toContain(DIAMOND)
  })

  it('is unverified when a schedule selector hides inside an envelope', async () => {
    const inner = scheduleBatchPayload(MIN_DELAY)
    const wrapped = encodeFunctionData({
      abi: parseAbi(['function execute(bytes payload)']),
      args: [inner],
    })
    expect(readScheduleDelay(wrapped).kind).toBe('undecodable')
    const outcome = await statusOf(
      makeInput({
        to: TIMELOCK,
        data: wrapped,
        storedTxData: { operation: 0 },
      }),
      makeDeps(),
      CHECK_TIMELOCK_DELAY
    )
    expect(outcome.status).toBe('error')
    expect(outcome.anchor).toBe('A-UNRESOLVED')
  })

  it('is unverified when the committed log names no timelock', async () => {
    const data = scheduleBatchPayload(MIN_DELAY)
    const outcome = await statusOf(
      makeInput({ to: TIMELOCK, data, storedTxData: { operation: 0 } }),
      makeDeps({
        committedDeployments: async () =>
          new Map([[DIAMOND.toLowerCase(), 'LiFiDiamond']]),
      }),
      CHECK_TIMELOCK_DELAY
    )
    expect(outcome.status).toBe('error')
  })

  it('is unverified when the live minimum could not be read', async () => {
    const data = scheduleBatchPayload(MIN_DELAY)
    const outcome = await statusOf(
      makeInput({ to: TIMELOCK, data, storedTxData: { operation: 0 } }),
      makeDeps({
        timelockMinDelay: async () => {
          throw new Error('rpc down')
        },
      }),
      CHECK_TIMELOCK_DELAY
    )
    expect(outcome.status).toBe('error')
    expect(outcome.anchor).toBe('A-CHAIN')
  })
})

describe('the refusal the funnels call', () => {
  /** The clean proposal, and the key the signer would present for it. */
  const cleanProposal = async (): Promise<{
    input: IIntegrityAssertInput
    key: string
  }> => {
    const input = makeInput({
      storedSignatures: [
        { signer: OWNER, data: await ethSignSignature(OWNER_KEY, REAL_HASH) },
      ],
    })
    return {
      input,
      key: proposalKeyOf({
        to: input.to,
        value: input.signedValue,
        data: input.data,
        operation: input.signedOperation,
        nonce: input.signedNonce,
      }),
    }
  }

  it('lets a clean proposal through', async () => {
    const { input, key } = await cleanProposal()
    const run = await runIntegrityAsserts(input, makeDeps())
    expect(run.verdict.hardBlocked).toBe(false)
    expect(run.gradedKey).toBe(key)
    expect(() => assertIntegrityAssertsAllowSigning(run, key)).not.toThrow()
  })

  it('lets an owner rotation through — the Safe addressing itself is not a red', async () => {
    // The false-red case: a rotation is a Call to the Safe, signed by owners
    // who are still owners. A guard that blocked it would look safe and be
    // wrong, because it locks the fleet out of rotating its own signers.
    const input = makeInput({
      to: SAFE,
      data: OWNER_ROTATION_PAYLOAD,
      storedTxData: {
        to: SAFE,
        value: '0',
        data: OWNER_ROTATION_PAYLOAD,
        operation: 0,
        nonce: NONCE,
      },
      storedSignatures: [
        { signer: OWNER, data: await ethSignSignature(OWNER_KEY, REAL_HASH) },
        {
          signer: SECOND_OWNER,
          data: await ethSignSignature(SECOND_OWNER_KEY, REAL_HASH),
        },
      ],
    })
    const run = await runIntegrityAsserts(input, makeDeps())
    expect(run.verdict.hardBlocked).toBe(false)
    expect(run.verdict.blocking).toEqual([])
    expect(() =>
      assertIntegrityAssertsAllowSigning(run, run.gradedKey)
    ).not.toThrow()
  })

  it('grades the key the funnels compute from the same struct', async () => {
    // The funnels present `proposalKeyOf(safeTransaction.data)`. If this module
    // normalised any of those fields on its way to the key, the two would
    // disagree and every proposal would be refused as "a different
    // transaction" — a false red that no assertion of its own would explain.
    const struct = {
      to: DIAMOND,
      value: 0n,
      data: PLAIN_PAYLOAD,
      operation: 0,
      nonce: BigInt(NONCE),
    }
    const run = await runIntegrityAsserts(
      makeInput({
        to: struct.to,
        data: struct.data,
        signedValue: String(struct.value),
        signedOperation: struct.operation,
        signedNonce: Number(struct.nonce),
      }),
      makeDeps()
    )
    expect(run.gradedKey).toBe(proposalKeyOf(struct))
  })

  it('agrees with the funnels on a proposal that carries no payload', async () => {
    // An absent payload is the one field the two spellings could diverge on:
    // `proposalKeyOf` reads it as the empty string, so a `?? '0x'` anywhere on
    // the way in would produce a key nothing matches.
    const struct = {
      to: DIAMOND,
      value: 0n,
      operation: 0,
      nonce: BigInt(NONCE),
    }
    const run = await runIntegrityAsserts(
      makeInput({
        to: struct.to,
        // Deliberately absent, which the declared type forbids and a Mongo row
        // can still be missing.
        data: undefined as unknown as Hex,
        signedValue: '0',
        signedOperation: 0,
        signedNonce: NONCE,
      }),
      makeDeps()
    )
    expect(run.gradedKey).toBe(proposalKeyOf(struct))
    // …and an unreadable payload is refused rather than repaired: the delay
    // check registers and cannot conclude.
    expect(run.registered).toContain(CHECK_TIMELOCK_DELAY)
    expect(run.verdict.hardBlocked).toBe(true)
    // On the delay check specifically: `hardBlocked` alone would also be
    // satisfied by any other check refusing on this input.
    expect(run.verdict.blocking.map((blocked) => blocked.checkId)).toContain(
      CHECK_TIMELOCK_DELAY
    )
  })

  it('blocks a tampered stored hash', async () => {
    const input = makeInput({ documentSafeTxHash: TAMPERED_HASH })
    const run = await runIntegrityAsserts(input, makeDeps())
    expect(run.verdict.hardBlocked).toBe(true)
    expect(() =>
      assertIntegrityAssertsAllowSigning(run, run.gradedKey)
    ).toThrow(/INT-SAFE-TX-HASH/)
  })

  it('blocks a foreign signature', async () => {
    const input = makeInput({
      storedSignatures: [
        {
          signer: STRANGER,
          data: await ethSignSignature(STRANGER_KEY, REAL_HASH),
        },
      ],
    })
    const run = await runIntegrityAsserts(input, makeDeps())
    expect(() =>
      assertIntegrityAssertsAllowSigning(run, run.gradedKey)
    ).toThrow(/INT-SIGNATURES/)
  })

  it('blocks a target nothing names', async () => {
    const input = makeInput({
      to: UNKNOWN_TARGET,
      storedTxData: { operation: 0 },
    })
    const run = await runIntegrityAsserts(input, makeDeps())
    expect(() =>
      assertIntegrityAssertsAllowSigning(run, run.gradedKey)
    ).toThrow(/INT-TARGET/)
  })

  it('blocks a schedule whose delay is too short', async () => {
    const input = makeInput({
      to: TIMELOCK,
      data: scheduleBatchPayload(MIN_DELAY - 1n),
      storedTxData: { operation: 0 },
    })
    const run = await runIntegrityAsserts(input, makeDeps())
    expect(() =>
      assertIntegrityAssertsAllowSigning(run, run.gradedKey)
    ).toThrow(/INT-TIMELOCK-DELAY/)
  })

  it('refuses when no run was produced at all', () => {
    expect(() =>
      assertIntegrityAssertsAllowSigning(undefined, 'anything')
    ).toThrow(/no verdict for this transaction at all/)
  })

  it('refuses a clean verdict about a different transaction', async () => {
    const { input } = await cleanProposal()
    const run = await runIntegrityAsserts(input, makeDeps())
    expect(run.verdict.hardBlocked).toBe(false)
    expect(() =>
      assertIntegrityAssertsAllowSigning(run, 'some-other-proposal')
    ).toThrow(/a different transaction/)
  })
})

describe('what the signer sees before the prompt', () => {
  it('names every check and its anchor on a clean run', async () => {
    // A real signature, so this is the run in which nothing refuses — with the
    // default empty set the signature check itself blocks, and then no test
    // here renders an all-pass run.
    const lines = renderIntegrityAsserts(
      await runIntegrityAsserts(
        makeInput({
          storedSignatures: [
            {
              signer: OWNER,
              data: await ethSignSignature(OWNER_KEY, REAL_HASH),
            },
          ],
        }),
        makeDeps()
      )
    ).join('\n')
    for (const checkId of [
      CHECK_SAFE_ADDRESS,
      CHECK_SAFE_TX_HASH,
      CHECK_SIGNATURES,
      CHECK_FIXED_FIELDS,
      CHECK_TARGET,
    ])
      expect(lines).toContain(checkId)
    expect(lines).toContain('PASS')
    // The delay check had nothing to say, and says so rather than being absent.
    expect(lines).toContain(CHECK_TIMELOCK_DELAY)
    expect(lines).toContain('NOT APPLICABLE')
    // The same words the check ledger uses one panel down. A second synonym
    // here teaches a signer that the two panels mean different things.
    expect(lines).not.toContain('NO CLAIM')
  })

  it('prints the expected and actual values of a blocking check', async () => {
    const lines = renderIntegrityAsserts(
      await runIntegrityAsserts(
        makeInput({ documentSafeTxHash: TAMPERED_HASH }),
        makeDeps()
      )
    ).join('\n')
    expect(lines).toContain('MISMATCH')
    expect(lines).toContain(TAMPERED_HASH)
    expect(lines).toContain(REAL_HASH)
  })

  it('says so rather than staying silent when nothing ran', () => {
    const lines = renderIntegrityAsserts(undefined).join('\n')
    expect(lines).toContain('REFUSED')
    expect(lines).toContain('no verdict for this transaction at all')
  })

  it('prints a status it does not recognise as unverified, never as a pass', async () => {
    // `recordCheck` refuses a status the ledger does not define, so this state
    // cannot be reached through the module's own path — only by a rehydrated
    // document or a direct push into the results log, built here.
    // Left untested, the renderer's fallback would be code nothing had ever
    // exercised, sitting on the one path where being wrong prints green.
    const run = await runIntegrityAsserts(makeInput(), makeDeps())
    const result = run.ledger.results.find(
      (entry) => entry.checkId === CHECK_TARGET
    )
    if (!result) throw new Error('no target result to rewrite')
    const forged = {
      ...run,
      ledger: {
        ...run.ledger,
        results: [{ ...result, status: 'constructor' as never }],
      },
    }

    const lines = renderIntegrityAsserts(forged).join('\n')
    expect(lines).toContain('UNVERIFIED')
    // The paired absence: it must not have borrowed a bucket from the
    // prototype chain, and must not read as a pass.
    expect(lines).not.toContain('PASS')
    expect(lines).not.toContain('Object')
  })
})

describe('a run that graded nothing cannot authorise a signature', () => {
  // Built as a literal rather than driven through `runIntegrityAsserts`: no
  // assertion returns `not-applicable` today, so the only way to reach the
  // state the verdict already models is to state it. The point of the test is
  // that the refusal does not depend on an assertion ever learning to.
  const runThatGraded = (
    overrides: Partial<ILedgerVerdict> = {}
  ): IIntegrityAssertRun => ({
    ledger: {
      checks: new Map(),
      expectedNetworks: [],
      results: [],
    } satisfies ICheckLedger,
    verdict: {
      hardBlocked: false,
      nothingGraded: false,
      blocking: [],
      requiresAcknowledgement: [],
      relaxed: [],
      totals: {
        pass: 1,
        fail: 0,
        error: 0,
        needsAck: 0,
        missing: 0,
        notApplicable: 0,
      },
      ...overrides,
    },
    registered: [],
    gradedKey: 'proposal-under-test',
  })

  it('refuses when every result was not-applicable, though nothing blocked', () => {
    const run = runThatGraded({
      nothingGraded: true,
      totals: {
        pass: 0,
        fail: 0,
        error: 0,
        needsAck: 0,
        missing: 0,
        notApplicable: 3,
      },
    })

    // The precondition, stated so a future change that makes this run block for
    // some other reason cannot pass this test while the term under test is gone.
    expect(run.verdict.hardBlocked).toBe(false)

    expect(() =>
      assertIntegrityAssertsAllowSigning(run, run.gradedKey)
    ).toThrow(/no graded result at all/u)
  })

  it('still lets a run that graded something through', () => {
    const run = runThatGraded()
    expect(() =>
      assertIntegrityAssertsAllowSigning(run, run.gradedKey)
    ).not.toThrow()
  })
})
