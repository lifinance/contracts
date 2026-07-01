/**
 * Move native TRX from an outgoing Tron wallet to a new wallet, during an SC-dev offboarding
 * where the outgoing dev wallet also holds TRX. Tron has no staging diamond to re-own, so this
 * only sweeps funds. Any TRC20 balances are swept separately with:
 *   bun troncast send <token> "transfer(address,uint256)" <newWallet>,<amount> --private-key <key>
 *
 * A reserve is left behind for the network fee (and the ~1.1 TRX one-time account-activation fee
 * charged when the destination has never been used on Tron).
 *
 * USAGE:
 *   bunx tsx ./script/tasks/moveTronFundsToNewWallet.ts <newTronBase58Address>
 *   bunx tsx ./script/tasks/moveTronFundsToNewWallet.ts <newTronBase58Address> --execute
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import { initTronWeb, waitForConfirmation } from '../troncast/utils/tronweb'
import { getEnvVar } from '../utils/utils'

const SUN_PER_TRX = 1_000_000

interface ITronSendResult {
  result?: boolean
  txid?: string
  transaction?: { txID?: string }
}

const main = defineCommand({
  meta: {
    name: 'moveTronFundsToNewWallet',
    description:
      'Sweep native TRX from an outgoing Tron wallet to a new wallet',
  },
  args: {
    newWallet: {
      type: 'positional',
      description: 'Destination Tron address (base58, T...)',
      required: true,
    },
    'old-key-env': {
      type: 'string',
      description: 'Env var holding the outgoing wallet key',
      default: 'PRIVATE_KEY',
    },
    'reserve-trx': {
      type: 'string',
      description: 'TRX to leave behind for fees + account activation',
      default: '2',
    },
    execute: {
      type: 'boolean',
      description: 'Broadcast the transfer (otherwise dry-run)',
      default: false,
    },
  },
  async run({ args }) {
    const privateKey = getEnvVar(args['old-key-env']).trim().replace(/^0x/, '')
    const tronWeb = initTronWeb('mainnet', privateKey)

    const from = tronWeb.defaultAddress.base58
    if (!from) {
      consola.error('Could not derive the outgoing Tron address from the key.')
      process.exit(1)
    }
    const newWallet = args.newWallet
    if (!tronWeb.isAddress(newWallet)) {
      consola.error(`Invalid Tron address: ${newWallet}`)
      process.exit(1)
    }
    if (newWallet === from) {
      consola.error(
        'Outgoing and new wallet are the same address — nothing to sweep.'
      )
      process.exit(1)
    }

    const balanceSun = await tronWeb.trx.getBalance(from)
    const reserveSun = Math.round(parseFloat(args['reserve-trx']) * SUN_PER_TRX)
    const amountSun = balanceSun - reserveSun

    consola.info(
      `From ${from} -> ${newWallet} | balance ${
        balanceSun / SUN_PER_TRX
      } TRX | reserve ${reserveSun / SUN_PER_TRX} TRX`
    )

    if (amountSun <= 0) {
      consola.warn('Balance does not exceed the reserve — nothing to sweep.')
      return
    }

    if (!args.execute) {
      consola.log(`DRY-RUN would send ${amountSun / SUN_PER_TRX} TRX`)
      return
    }

    const tx = (await tronWeb.trx.sendTransaction(
      newWallet,
      amountSun
    )) as ITronSendResult
    const txId = tx.txid ?? tx.transaction?.txID
    if (!txId) {
      consola.error(`Transfer was not broadcast: ${JSON.stringify(tx)}`)
      process.exit(1)
    }

    await waitForConfirmation(tronWeb, txId)
    consola.success(
      `Sent ${
        amountSun / SUN_PER_TRX
      } TRX — https://tronscan.org/#/transaction/${txId}`
    )
  },
})

runMain(main)
