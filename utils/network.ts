import 'dotenv/config'
import * as fs from 'fs'
import path from 'path'
import { Chain } from 'viem'
import * as chains from 'viem/chains'
export function node_url(networkName: string): string {
  if (networkName) {
    const uri = process.env['ETH_NODE_URI_' + networkName.toUpperCase()]
    if (uri && uri !== '') {
      return uri
    }
  }

  if (networkName === 'localhost') {
    // do not use ETH_NODE_URI
    return 'http://localhost:8545'
  }

  let uri = process.env.ETH_NODE_URI
  if (uri) {
    uri = uri.replace('{{networkName}}', networkName)
  }
  if (!uri || uri === '') {
    // throw new Error(`environment variable "ETH_NODE_URI" not configured `);
    return ''
  }
  if (uri.indexOf('{{') >= 0) {
    throw new Error(
      `invalid uri or network not supported by node provider : ${uri}`
    )
  }
  return uri
}

export function getMnemonic(networkName?: string): string {
  if (networkName) {
    const mnemonic = process.env['MNEMONIC_' + networkName.toUpperCase()]
    if (mnemonic && mnemonic !== '') {
      return mnemonic
    }
  }

  const mnemonic = process.env.MNEMONIC
  if (!mnemonic || mnemonic === '') {
    return 'test test test test test test test test test test test junk'
  }
  return mnemonic
}

export function accounts(networkName?: string): { mnemonic: string } {
  return { mnemonic: getMnemonic(networkName) }
}

// get a list of all networks from our ./networks file
export function getAllNetworks(): string[] {
  try {
    // Read file contents
    const fileContents = fs.readFileSync(
      path.join(__dirname, '../networks'),
      'utf-8'
    )

    // Split the contents by new lines to get an array of network names
    const networkNames = fileContents
      .split('\n')
      .map((name) => name.trim())
      .filter((name) => name !== '')

    return networkNames
  } catch (error) {
    console.error(`Error reading file: ${JSON.stringify(error, null, 2)}`)
    return []
  }
}

// viem chain handling
const chainNameMappings: Record<string, string> = {
  zksync: 'zkSync',
  polygonzkevm: 'polygonZkEvm',
}

const chainMap: Record<string, Chain> = {}
for (const [k, v] of Object.entries(chains)) {
  // @ts-ignore
  chainMap[k] = v
}

export const getViemChainForNetworkName = (network: string): Chain => {
  const chainName = chainNameMappings[network] || network
  const chain: Chain = chainMap[chainName]

  if (!chain) throw new Error(`Viem chain not found for network ${network}`)
  return chain
}
