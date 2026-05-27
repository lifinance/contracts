/**
 * Pre-stages Safe unpause transaction proposals for Phase 2b emergency-pause testing.
 * Proposes a Safe tx targeting the LiFiTimelockController on sophon, boba, and rootstock
 * so signers can confirm and execute without reconstructing calldata during the test.
 *
 * Call chain at execution time:
 *   1. Signers reach threshold → Safe.execTransaction runs.
 *   2. The Safe calls `LiFiTimelockController.unpauseDiamond([])` (the Timelock's own
 *      function — a thin auth wrapper gated by `onlyRole(TIMELOCK_ADMIN_ROLE)`, held by
 *      the Safe; intentionally bypasses `minDelay`, see
 *      `src/Security/LiFiTimelockController.sol:70-82`).
 *   3. That wrapper does exactly one thing: `EmergencyPause(diamond).unpauseDiamond([])`.
 *      Now `msg.sender` at the Diamond is the Timelock, which satisfies
 *      `LibDiamond.enforceIsContractOwner()` (see `EmergencyPauseFacet.sol:132-134`)
 *      because production diamonds are Timelock-owned. The real storage-rewrite
 *      logic lives on the Diamond.
 *
 * Why not propose `to: diamondAddress` directly:
 *   - `Diamond.owner() == LiFiTimelockController` on every checked production network
 *     (verified via `cast call <diamond> "owner()"`).
 *   - `EmergencyPauseFacet.unpauseDiamond` only checks contract owner, so Safe →
 *     Diamond directly reverts with `OnlyContractOwner()`.
 *
 * Why not the `--timelock` flag (which would wrap in `scheduleBatch`):
 *   - That path respects `minDelay` and breaks the 5-minute unpause SLA.
 *   - The Timelock's own `unpauseDiamond` IS the bypass — wrapping it in `scheduleBatch`
 *     would be both redundant and slow.
 *
 * The function signature `unpauseDiamond(address[])` is identical on the Timelock and
 * the Diamond, so the calldata (`0x2fc487ae` + ABI-encoded empty array) is the same
 * either way — only the proposal's `to` address differs.
 *
 * Prerequisites: PRIVATE_KEY_PRODUCTION must be set and belong to a Safe owner.
 * Run once before the Phase 2b test session: `bunx tsx ./script/tasks/temp/prepareUnpauseProposals.ts`
 */

import 'dotenv/config'

import { consola } from 'consola'

import { EnvironmentEnum } from '../../common/types'
import { runPropose } from '../../deploy/safe/propose-to-safe'
import { getDeployments } from '../../utils/deploymentHelpers'

// unpauseDiamond([]) calldata: selector 0x2fc487ae + ABI-encoded empty address array
const UNPAUSE_CALLDATA =
  '0x2fc487ae00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000'

const NETWORKS = ['sophon', 'boba', 'rootstock'] as const

async function main(): Promise<number> {
  consola.info(
    'Pre-staging unpauseDiamond([]) proposals for Phase 2b test networks...'
  )
  consola.info(`Networks: ${NETWORKS.join(', ')}`)
  consola.box(
    'This will sign and store Safe transactions in MongoDB.\nEnsure PRIVATE_KEY_PRODUCTION belongs to a Safe owner.'
  )

  let succeeded = 0
  let failed = 0

  for (const network of NETWORKS) {
    consola.start(`Proposing unpause for ${network}...`)
    try {
      const deployments = await getDeployments(
        network,
        EnvironmentEnum.production
      )
      const timelockAddress = deployments.LiFiTimelockController as
        | string
        | undefined
      if (!timelockAddress)
        throw new Error(
          `No LiFiTimelockController deployment found for ${network}`
        )

      // `timelock: false` so propose-to-safe.ts does NOT wrap this in
      // `scheduleBatch` (which would enforce minDelay). The Timelock's
      // `unpauseDiamond` function is itself the minDelay bypass.
      await runPropose({
        network,
        to: timelockAddress,
        calldata: UNPAUSE_CALLDATA,
        timelock: false,
      })
      consola.success(`[${network}] Proposal stored in MongoDB`)
      succeeded++
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      consola.error(`[${network}] Failed to propose: ${msg}`)
      failed++
    }
  }

  console.log('')
  consola.info(`Done. Succeeded: ${succeeded}, Failed: ${failed}`)
  return failed
}

main()
  .then((failed) => process.exit(failed > 0 ? 1 : 0))
  .catch((err) => {
    consola.error('Fatal error:', err)
    process.exit(1)
  })
