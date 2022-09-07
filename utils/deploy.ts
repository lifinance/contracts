import { Address } from 'defender-relay-client'
import { ContractFactory } from 'ethers'
import { FormatTypes } from 'ethers/lib/utils'
import { ABI } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

export const getDeployFunction = (hre: HardhatRuntimeEnvironment) => {
  const { ethers, deployments } = hre

  const deploy = async (name: string, options: any) => {
    const create2Salt =
      '0x0000000000000000000000000000000000000000000000000000000000000000'
    const create2DeployerAddress = '0x2Fd525b8B2e2a69d054dCCB033a0e33E0B4AB370' // Refactor later

    const factory: ContractFactory = await ethers.getContractFactory(name)

    const unsignedTx = factory.getDeployTransaction(
      ...(options.args || undefined)
    )

    const create2Address = getCreate2Address(
      create2DeployerAddress,
      create2Salt,
      unsignedTx.data as string
    )

    const abi = JSON.parse(
      factory.interface.format(FormatTypes.json) as string
    ) as ABI

    const signer = await ethers.getSigner(options.from)

    const artifact = await hre.deployments.getExtendedArtifact(name)

    const bytecode = await signer.provider?.getCode(create2Address)
    if (bytecode !== '0x') {
      console.log(`Reusing contract ${name} at ${create2Address}`)
      deployments.save(name, {
        address: create2Address,
        ...artifact,
      })

      return
    }

    unsignedTx.to = create2DeployerAddress
    const data = unsignedTx.data as string
    unsignedTx.data = create2Salt + data.slice(2)

    const tx = await signer.sendTransaction(unsignedTx)
    console.log(`Deploying ${name} - TX: ${tx.hash}`)
    const receipt = await tx.wait()

    if (receipt.status) {
      console.log(`Contract deployed to address ${create2Address}`)
      deployments.save(name, {
        abi,
        address: create2Address,
        receipt,
        transactionHash: tx.hash,
      })
    }
  }

  const getCreate2Address = (
    create2DeployerAddress: Address,
    salt: string,
    bytecode: string
  ): Address => {
    return ethers.utils.getAddress(
      '0x' +
        ethers.utils
          .solidityKeccak256(
            ['bytes'],
            [
              `0xff${create2DeployerAddress.slice(2)}${salt.slice(
                2
              )}${ethers.utils
                .solidityKeccak256(['bytes'], [bytecode])
                .slice(2)}`,
            ]
          )
          .slice(-40)
    )
  }

  return deploy
}
