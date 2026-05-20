/**
 * Pre-stages Safe unpause transaction proposals for Phase 2b emergency-pause testing.
 * Proposes unpauseDiamond([]) on gnosis, moonbeam, and rootstock to MongoDB so signers
 * can confirm and execute without needing to reconstruct the calldata during the test.
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

const NETWORKS = ['gnosis', 'moonbeam', 'rootstock'] as const

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
      const diamondAddress = deployments.LiFiDiamond as string | undefined
      if (!diamondAddress)
        throw new Error(`No diamond deployment found for ${network}`)

      await runPropose({
        network,
        to: diamondAddress,
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
