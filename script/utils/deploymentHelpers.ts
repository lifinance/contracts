import path from 'path'
import { fileURLToPath } from 'url'

import { EnvironmentEnum, type SupportedChain } from '../common/types'

/**
 * Utility function to dynamically import the deployments file for a chain.
 */
export const getDeployments = async (
  chain: SupportedChain,
  environment: EnvironmentEnum = EnvironmentEnum.staging
) => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const fileName =
    environment === EnvironmentEnum.production
      ? `${chain}.json`
      : `${chain}.staging.json`
  const filePath = path.resolve(__dirname, `../../deployments/${fileName}`)

  try {
    const deployments = await import(filePath)
    return deployments
  } catch (error) {
    throw new Error(
      `Deployments file not found for ${chain} (${environment}): ${filePath}`
    )
  }
}
