/**
 * CLI entry point for the production deploy gate on the bash direct-broadcast
 * route, for `sendOrPropose` in `script/helperFunctions.sh` to run from the repo
 * root before anything is broadcast. Exits 1 with the reason when the calldata
 * may not be sent; a 0 exit alone does not mean it may be, because a process
 * that never reached `runMain` also exits 0, so callers must also require
 * `DIRECT_BROADCAST_GATE_ALLOWED` on stdout.
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
 * Written straight to stdout, not through consola, on every successful CLI exit
 * so `assertDirectBroadcastCalldataGate` can refuse a process that exited 0
 * without ever running the gate. consola is silenced under `NODE_ENV=test`.
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
    process.stdout.write(`${DIRECT_BROADCAST_GATE_ALLOWED}\n`)
  },
})

// Not `import.meta.main`: tsx's resolve hook rewrites the entry URL, so Node
// never marks the module as main and the CLI would exit 0 without running.
// That hook also realpaths `import.meta.url` but leaves argv[1] as given, so
// both sides need realpathing or the compare fails through a symlinked path.
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
