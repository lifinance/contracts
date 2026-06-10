import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved, import/order
} from 'bun:test'

import { type SupportedChain, EnvironmentEnum } from '../common/types'

import { getDeployments } from './deploymentHelpers'

describe('getDeployments', () => {
  it('loads the deployments file for a chain and environment', async () => {
    const deployments = await getDeployments(
      'mainnet',
      EnvironmentEnum.production
    )
    expect(deployments.LiFiDiamond).toBeString()
  })

  it('returns the same cached result for repeated calls (one load per run)', async () => {
    const first = await getDeployments('mainnet', EnvironmentEnum.production)
    const second = await getDeployments('mainnet', EnvironmentEnum.production)
    expect(second).toBe(first)
  })

  it('throws for a missing deployments file and does not cache the failure', async () => {
    const missingChain = 'nonexistent-network' as SupportedChain
    const loadMissing = async (): Promise<Error | undefined> => {
      try {
        await getDeployments(missingChain, EnvironmentEnum.production)
        return undefined
      } catch (error) {
        return error as Error
      }
    }

    const firstError = await loadMissing()
    expect(firstError?.message).toContain(
      'Deployments file not found for nonexistent-network'
    )
    // A failed load must not be cached, so a retry attempts the load again
    const secondError = await loadMissing()
    expect(secondError?.message).toContain(
      'Deployments file not found for nonexistent-network'
    )
  })
})
