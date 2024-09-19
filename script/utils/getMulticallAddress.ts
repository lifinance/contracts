import { defineCommand, runMain } from 'citty'
const MULTICALL_DEPLOYMENTS_URL =
  'https://raw.githubusercontent.com/EthereumClassicDAO/multicall3/743c0015fac7f9331c24ca8bd8075e49f19f2ddd/deployments.json'

type MulticallDeployment = {
  name: string
  chainId: number
  url: string
}

const fetchMulticallDeploymentsFromGithub = async (): Promise<
  MulticallDeployment[]
> => {
  let result
  try {
    const response = await fetch(MULTICALL_DEPLOYMENTS_URL)
    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${MULTICALL_DEPLOYMENTS_URL}: ${response.statusText}`
      )
    }
    result = await response.json()
  } catch (error) {
    throw new Error(`Error fetching JSON: ${error}`)
  }
  return result
}

const extractContractAddressFromUrl = (url: string): string => {
  const match = url.match(/0x[a-fA-F0-9]{40}/)
  if (match) {
    return match[0]
  }
  throw new Error(`No contract address found in URL: ${url}`)
}

export const getMulticall3AddressForChain = async (chainId: number) => {
  // get all deployments
  const deployments = await fetchMulticallDeploymentsFromGithub()

  // find the address for the given chainId
  const matchedDeployment = deployments.find(
    (deployment) => deployment.chainId === chainId
  )

  // make sure a deployment was found
  if (!matchedDeployment)
    throw new Error(`No multicall deployment found for chainId ${chainId}`)

  // extract the address
  return extractContractAddressFromUrl(matchedDeployment.url)
}
