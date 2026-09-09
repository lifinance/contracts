/**
 * CLI entry point for the production deploy gate on the bash direct-broadcast
 * route, for `sendOrPropose` in `script/helperFunctions.sh` to run from the repo
 * root before anything is broadcast. Exits 0 when the calldata may be sent, 1
 * with the reason when not.
 *
 * The policy is `assertFunnelDeployGate`'s, unchanged: that route hands over
 * calldata, exactly what the funnels hand over, so the cut is recovered the same
 * way rather than through a second implementation. What differs is only that no
 * funnel runs here, which is why the call has to be made from the shell.
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import type { Hex } from 'viem'

import {
  assertFunnelDeployGate,
  createFunnelGateDeps,
} from './funnel-deploy-gate'

const main = defineCommand({
  meta: {
    name: 'assert-direct-broadcast-gate',
    description:
      'Gates a direct broadcast to a production diamond on main-equivalence or an audited freeze',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network the calldata would be broadcast to',
      required: true,
    },
    calldata: {
      type: 'string',
      description: 'The calldata about to be broadcast',
      required: true,
    },
  },
  async run({ args }) {
    try {
      await assertFunnelDeployGate(
        { network: args.network, calldatas: [args.calldata as Hex] },
        createFunnelGateDeps()
      )
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }

    consola.success(
      `Direct-broadcast deploy gate passed for ${args.network} - nothing has been broadcast yet.`
    )
  },
})

if (import.meta.main) runMain(main)
