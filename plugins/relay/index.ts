import { getRelayProvider } from '../../utils/relayer'
import { extendEnvironment } from 'hardhat/config'
import { getFeeData } from '../../utils/gas'
import { BigNumber, BigNumberish, ethers, providers } from 'ethers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { getDeployFunction } from '../../utils/deploy'

extendEnvironment((hre) => {
  const provider = getRelayProvider(hre.network.name)
  if (provider) {
    hre.ethers = {
      ...hre.ethers,
      provider: provider,
      getSigner: async (address: string): Promise<SignerWithAddress> => {
        address
        const signer = await RelaySignerWithAddress.create(provider.getSigner())
        return <SignerWithAddress>(<unknown>signer)
      },
      getSigners: async (): Promise<SignerWithAddress[]> => {
        const signer = await RelaySignerWithAddress.create(provider.getSigner())
        return [<SignerWithAddress>(<unknown>signer)]
      },
    }

    hre.getNamedAccounts = async () => {
      return {
        deployer: await provider.getSigner().getAddress(),
      }
    }

    // @ts-ignore
    hre.deployments.deploy = getDeployFunction(hre)
  }
})

class RelaySignerWithAddress extends ethers.Signer {
  public static async create(signer: ethers.providers.JsonRpcSigner) {
    return new RelaySignerWithAddress(await signer.getAddress(), signer)
  }

  private constructor(
    public readonly address: string,
    private readonly _signer: ethers.providers.JsonRpcSigner
  ) {
    super()
    ;(this as any).provider = _signer.provider
  }

  public async getAddress(): Promise<string> {
    return this.address
  }

  public signMessage(message: string | ethers.utils.Bytes): Promise<string> {
    return this._signer.signMessage(message)
  }

  public signTransaction(
    transaction: ethers.utils.Deferrable<ethers.providers.TransactionRequest>
  ): Promise<string> {
    return this._signer.signTransaction(transaction)
  }

  public async sendTransaction(
    transaction: ethers.utils.Deferrable<ethers.providers.TransactionRequest>
  ): Promise<ethers.providers.TransactionResponse> {
    const network = (await this.provider?.getNetwork())?.name
    const feeData = await getFeeData(
      this.provider as providers.Provider,
      network || ''
    )
    let newTx: ethers.utils.Deferrable<ethers.providers.TransactionRequest>
    if (feeData.maxFeePerGas === null) {
      newTx = {
        ...transaction,
        maxFeePerGas: BigNumber.from(0),
        maxPriorityFeePerGas: BigNumber.from(0),
        gasPrice: feeData.gasPrice as BigNumberish,
      }
    } else {
      newTx = {
        ...transaction,
        maxFeePerGas: feeData.maxFeePerGas as BigNumberish,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas as BigNumberish,
      }
    }
    return this._signer.sendTransaction(newTx)
  }

  public connect(provider: ethers.providers.Provider): RelaySignerWithAddress {
    return new RelaySignerWithAddress(
      this.address,
      this._signer.connect(provider)
    )
  }

  public _signTypedData(
    ...params: Parameters<ethers.providers.JsonRpcSigner['_signTypedData']>
  ): Promise<string> {
    return this._signer._signTypedData(...params)
  }

  public toJSON() {
    return `<SignerWithAddress ${this.address}>`
  }
}
