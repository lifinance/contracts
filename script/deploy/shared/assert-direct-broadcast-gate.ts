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

import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import type { Hex } from 'viem'

import {
  assertFunnelDeployGate,
  createFunnelGateDeps,
} from './funnel-deploy-gate'

/**
 * Printed on every successful CLI exit so `assertDirectBroadcastCalldataGate`
 * can refuse a process that exited 0 without ever running the gate.
 */
export const DIRECT_BROADCAST_GATE_ALLOWED = 'DIRECT_BROADCAST_GATE_ALLOWED'

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
    console.log(DIRECT_BROADCAST_GATE_ALLOWED)
  },
})

// `import.meta.main` only exists on Node >= 22.18 and package.json allows
// older, where it is undefined and the CLI would exit 0 without running. The
// loader realpaths `import.meta.url`, so argv[1] needs realpathing too.
const isEntrypoint = (): boolean => {
  if (process.argv[1] === undefined) return false
  try {
    return (
      realpathSync(path.resolve(process.argv[1])) ===
      realpathSync(fileURLToPath(import.meta.url))
    )
  } catch {
    return false
  }
}

if (isEntrypoint()) runMain(main)
