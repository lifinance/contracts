import path from 'path'
import { fileURLToPath } from 'url'

import { IEnvironmentEnum, type SupportedChain } from '../common/types'

/**
 * Utility function to dynamically import the deployments file for a chain.
 */
export const getDeployments = async (
  chain: SupportedChain,
  environment: IEnvironmentEnum = IEnvironmentEnum.staging
) => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const fileName =
    environment === IEnvironmentEnum.production
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
