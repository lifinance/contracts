import { ethers, providers } from 'ethers'
import axios from 'axios'

export const getFeeData = async (
  provider: providers.Provider,
  network: string
): Promise<ethers.providers.FeeData | any> => {
  if (network === 'polygon' || network === 'matic') {
    const { data } = await axios.get(
      'https://gasstation-mainnet.matic.network/v2'
    )

    return {
      maxFeePerGas: ethers.utils.parseUnits(
        Math.ceil(data.fast.maxFee) + '',
        'gwei'
      ),
      maxPriorityFeePerGas: ethers.utils.parseUnits(
        Math.ceil(data.fast.maxPriorityFee) + '',
        'gwei'
      ),
      gasPrice: null,
    }
  }
  const feeData = await provider.getFeeData()

  return feeData
}
