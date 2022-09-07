import { providers } from 'ethers'
import { DefenderRelayProvider } from 'defender-relay-client/lib/ethers'
import { Relayer } from 'defender-relay-client'

export const getRelayProvider = (network = '') => {
  let provider: providers.JsonRpcProvider | undefined = undefined

  const prefix = `${network.toUpperCase()}_RELAY_API`
  if (process.env[`${prefix}_KEY`] !== undefined) {
    const credentials = {
      apiKey: process.env[`${prefix}_KEY`] as string,
      apiSecret: process.env[`${prefix}_SECRET`] as string,
    }
    provider = new DefenderRelayProvider(credentials)
  }

  return provider
}
