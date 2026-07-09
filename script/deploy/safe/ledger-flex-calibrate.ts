/**
 * Ledger Flex wrap calibration harness (EXSC-580 spike).
 *
 * Displays crafted SafeTx EIP-712 payloads on a physical Ledger Flex so the
 * device's native `data` review screen can be photographed and its exact line
 * breaks recorded. The `data` field renders arbitrary UPPERCASE hex, so
 * homogeneous strings (all `0`, all `A`, ...) isolate each glyph's width and
 * reveal chars-per-line directly. The measured widths are baked into
 * `ledger-flex-preview.ts` (GLYPH_WIDTH); rerun this to recalibrate, or to
 * capture the still-unmeasured lowercase a-f from address fields.
 *
 * Run (device connected, unlocked, Ethereum app open):
 *   bunx tsx script/deploy/safe/ledger-flex-calibrate.ts            # all targets
 *   bunx tsx script/deploy/safe/ledger-flex-calibrate.ts --target T_A
 *   bunx tsx script/deploy/safe/ledger-flex-calibrate.ts --list     # print only
 *
 * For each target you'll see the real "Review struct SafeTx" → `data` screens.
 * Photograph the `data` field, record the chars on each line, then tap REJECT
 * on the device. Nothing is broadcast — the verifyingContract/to are throwaway
 * values and the payload never leaves your machine, so an accidental approval
 * is harmless.
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { getAddress, type Account, type Hex } from 'viem'

import { closeLedgerConnection, getLedgerAccount } from './ledger'

interface ICalibrationTarget {
  name: string
  /** Purpose / what this target isolates. */
  note: string
  /** 60 hex chars (no 0x); shown on-device as `0x` + this, uppercased. */
  hex: string
}

// 30 bytes = 60 hex chars: several full on-device lines, and well under the
// ~104-char `data` preview budget so every row is a real (untruncated) break.
// One homogeneous target per uppercase glyph. The `data` field force-uppercases
// hex, so lowercase a-f can't be measured here — fit those from address samples.
const TARGETS: ICalibrationTarget[] = [
  { name: 'T_ZERO', note: 'digit width baseline', hex: '0'.repeat(60) },
  { name: 'T_A', note: 'uppercase A width', hex: 'A'.repeat(60) },
  { name: 'T_B', note: 'uppercase B width', hex: 'B'.repeat(60) },
  { name: 'T_C', note: 'uppercase C width', hex: 'C'.repeat(60) },
  { name: 'T_D', note: 'uppercase D width', hex: 'D'.repeat(60) },
  { name: 'T_E', note: 'uppercase E width', hex: 'E'.repeat(60) },
  { name: 'T_F', note: 'uppercase F width', hex: 'F'.repeat(60) },
  {
    name: 'T_DIGITS',
    note: 'confirms digits are equal-width (should match T_ZERO per line)',
    hex: '0123456789'.repeat(6),
  },
  {
    name: 'T_MIX',
    note: 'alternating narrow/wide → cross-checks greedy fill',
    hex: '0A'.repeat(30),
  },
  {
    name: 'T_REAL',
    note: 'realistic mixed sample (selector + address + padding) → validates cumulative-width drift; model predicts 18/17/18/9',
    hex: 'E318B52B9740A8E0197689D144B19DA4BDC9EF65FEF11CDA000000000000',
  },
]

// Throwaway values for the non-`data` fields. verifyingContract and `to` still
// render as (proportional-wrapped) address screens — capturing those is a bonus
// lowercase-glyph sample, but the `data` field is the primary instrument.
const DUMMY_SAFE = getAddress('0x1111111111111111111111111111111111111111')
const DUMMY_TO = getAddress('0x00000000000000000000000000000000000000ee')
const ZERO_ADDR = getAddress('0x0000000000000000000000000000000000000000')
const DISPLAY_CHAIN_ID = 1 // display-only; does not affect hex wrapping

/**
 * Build the Safe EIP-712 typed data with a crafted `data` field.
 *
 * The real Safe flow signs via viem's `walletClient.signTypedData`, which
 * auto-injects the `EIP712Domain` type from `domain` before calling the
 * account. We call the account's `signTypedData` directly (no walletClient),
 * so we must spell out `EIP712Domain` ourselves — otherwise `hw-app-eth`
 * rejects the payload with `0x6a80` (invalid data). The entries mirror the
 * domain fields present (chainId, verifyingContract), in viem's field order.
 */
const buildSafeTypedData = (data: Hex) => ({
  domain: {
    chainId: DISPLAY_CHAIN_ID,
    verifyingContract: DUMMY_SAFE,
  },
  types: {
    EIP712Domain: [
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
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
  primaryType: 'SafeTx' as const,
  message: {
    to: DUMMY_TO,
    value: 0n,
    data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDR,
    refundReceiver: ZERO_ADDR,
    nonce: 0n,
  },
})

const displayString = (t: ICalibrationTarget): Hex =>
  `0x${t.hex.toUpperCase()}` as Hex

const printTargets = (): void => {
  consola.info(
    'Crafted calibration targets (shown on-device as the `data` field):'
  )
  for (const t of TARGETS)
    consola.log(
      `  ${t.name.padEnd(9)} ${displayString(t)}\n${' '.repeat(12)}${t.note}`
    )
}

/** Display one target on the device and wait for the user to reject. */
const runTarget = async (
  account: Account,
  t: ICalibrationTarget
): Promise<void> => {
  const display = displayString(t)
  consola.box(
    [
      `Target: ${t.name}`,
      t.note,
      '',
      `data = ${display}`,
      '',
      'On the device: step to "Review struct SafeTx" → the `data` screen.',
      'Photograph it, note the chars on each line, then tap REJECT.',
    ].join('\n')
  )
  await consola.prompt(`Press Enter to send ${t.name} to the device…`, {
    type: 'confirm',
    initial: true,
  })

  const sign = account.signTypedData
  if (!sign) throw new Error('Ledger account does not support signTypedData')

  try {
    const typedData = buildSafeTypedData(display)
    // Cast: the ledger signer forwards this straight to hw-app-eth's
    // signEIP712Message; viem's TypedDataDefinition type is stricter than the
    // runtime shape hw-app-eth accepts.
    await sign(
      typedData as Parameters<NonNullable<Account['signTypedData']>>[0]
    )
    consola.warn(
      `${t.name}: device APPROVED (harmless — never broadcast). Recorded, moving on.`
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    // 0x6985 = "Condition of use not satisfied" — either a genuine user reject
    // OR blind signing disabled (device auto-rejects). Surface everything so a
    // fast flicker-then-error is distinguishable from a real on-screen reject.
    const rejected = /0x6985|denied by the user|condition of use/i.test(msg)
    if (rejected)
      consola.info(
        `${t.name}: device returned 0x6985 (reject OR blind-signing disabled). If the screen only flickered, enable Blind signing.`
      )
    else consola.error(`${t.name}: signing FAILED (not a reject): ${msg}`)
  }
}

const main = defineCommand({
  meta: {
    name: 'ledger-flex-calibrate',
    description:
      'Display crafted SafeTx data on a Ledger Flex to calibrate proportional-font hex wrapping (EXSC-580 spike).',
  },
  args: {
    target: {
      type: 'string',
      description: `Single target to display (${TARGETS.map((t) => t.name).join(
        ', '
      )}); omit for all`,
      required: false,
    },
    list: {
      type: 'boolean',
      description: 'Print the target strings and exit (no device interaction)',
      required: false,
    },
    ledgerLive: {
      type: 'boolean',
      description: 'Use Ledger Live derivation path',
      required: false,
      default: true,
    },
    accountIndex: {
      type: 'string',
      description: 'Ledger account index (default: 0)',
      required: false,
    },
  },
  async run({ args }) {
    if (args.list) {
      printTargets()
      return
    }

    const selected = args.target
      ? TARGETS.filter((t) => t.name === args.target)
      : TARGETS
    if (selected.length === 0) {
      consola.error(
        `Unknown target "${args.target}". Known: ${TARGETS.map(
          (t) => t.name
        ).join(', ')}`
      )
      process.exit(1)
    }

    consola.info('=== Ledger Flex wrap calibration ===')
    consola.info('Connect + unlock your Ledger and open the Ethereum app.')
    printTargets()

    const { account, transport } = await getLedgerAccount({
      ledgerLive: args.ledgerLive,
      accountIndex: args.accountIndex ? Number(args.accountIndex) : 0,
    })
    consola.success(`Connected: ${account.address}`)

    // The SafeTx struct is blind-signed; without this setting the device
    // refuses and the `data` review screen never appears.
    consola.warn(
      'Ensure "Blind signing" is enabled in the Ethereum app settings, or the SafeTx `data` screen will not appear.'
    )

    try {
      for (const t of selected) await runTarget(account, t)
    } finally {
      await closeLedgerConnection(transport)
    }

    consola.success(
      'Done. Record the character count of each line per target; those counts calibrate GLYPH_WIDTH in ledger-flex-preview.ts.'
    )
  },
})

runMain(main)
