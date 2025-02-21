import { consola } from 'consola'
import { $ } from 'zx'
import { defineCommand, runMain } from 'citty'
import * as path from 'path'
import * as fs from 'fs'
import toml from 'toml' // make sure to install this: npm install toml
import { Address, PublicClient, createPublicClient, http } from 'viem'
import { getViemChainForNetworkName } from '../utils/viemScriptHelpers'

const main = defineCommand({
  meta: {
    name: 'LIFI Diamond Deployment File Update',
    description:
      'Updates the deployment file to match the latest on-chain state.',
  },
  args: {
    network: {
      type: 'string',
      description: 'EVM network to check',
      required: true,
    },
  },
  async run({ args }) {
    const { default: networksConfig } = await import(
      '../../config/networks.json'
    )
    type NetworkName = keyof typeof networksConfig

    let { network } = args
    network = network.toLowerCase() as NetworkName

    consola.info(`Starting update process for network: ${network}`)

    const networkDeploymentLogPath = path.resolve(
      __dirname,
      '../../deployments/',
      `${network}.json`
    )
    const networkDiamondDeploymentLogPath = path.resolve(
      __dirname,
      '../../deployments/',
      `${network}.diamond.json`
    )

    type DeployLogContracts = Record<string, Address>
    const { default: networkDeployLogContracts } = (await import(
      networkDeploymentLogPath
    )) as { default: DeployLogContracts }
    const { default: networkDiamondDeployLogContracts } = (await import(
      networkDiamondDeploymentLogPath
    )) as { default: DeployLogContracts }

    const chain = getViemChainForNetworkName(network)
    const publicClient = createPublicClient({
      batch: { multicall: true },
      chain,
      transport: http(),
    })

    // ┌─────────────────────────────────────────────────────────┐
    // │   Check if Diamond Contract is deployed                 │
    // └─────────────────────────────────────────────────────────┘
    consola.box('Checking LiFiDiamond contract deployment...')
    const diamondDeployed = await checkIsDeployed(
      'LiFiDiamond',
      networkDeployLogContracts,
      publicClient
    )

    if (!diamondDeployed) {
      consola.error('LiFiDiamond contract is not deployed. Exiting process.')
      throw new Error('Diamond contract not found on-chain.')
    }
    consola.success('LiFiDiamond contract is deployed.')

    const diamondAddress = networkDeployLogContracts['LiFiDiamond']

    // ┌─────────────────────────────────────────────────────────┐
    // │   Check if all facets are registered in the diamond     │
    // └─────────────────────────────────────────────────────────┘
    consola.box('Verifying registered facets in LiFiDiamond...')
    $.quiet = true

    try {
      const foundryTomlPath = path.resolve(__dirname, '../../foundry.toml')
      const foundryTomlContent = fs.readFileSync(foundryTomlPath, 'utf8')
      const foundryConfig = toml.parse(foundryTomlContent)

      const etherscanConfig = foundryConfig.etherscan[network]
      if (!etherscanConfig) {
        throw new Error(
          `Etherscan configuration not found for network: ${network}`
        )
      }

      if (!(network in networksConfig)) {
        throw new Error(`Network "${network}" is not supported.`)
      }

      const baseUrl = etherscanConfig.url
      const typedNetwork = network as NetworkName
      const rpcUrl: string = networksConfig[typedNetwork].rpcUrl
      if (!rpcUrl) throw new Error(`RPC URL not found for network: ${network}`)

      const facetsResult =
        await $`cast call ${diamondAddress} "facets() returns ((address,bytes4[])[])" --rpc-url ${rpcUrl}`
      const rawString = facetsResult.stdout

      const jsonCompatibleString = rawString
        .replace(/\(/g, '[')
        .replace(/\)/g, ']')
        .replace(/0x[0-9a-fA-F]+/g, '"$&"')

      const onChainFacets = JSON.parse(jsonCompatibleString)

      if (!Array.isArray(onChainFacets)) {
        throw new Error('Unexpected format for on-chain facets data.')
      }

      const onChainRegisteredFacetContractsAddresses = onChainFacets.map(
        ([address]) => address.toLowerCase()
      )

      for (const onChainRegisteredFacetContractAddress of onChainRegisteredFacetContractsAddresses) {
        consola.log(`\n`)
        // fetching on chain registered facet version

        const onChainRegisteredFacetContractData = await fetchContractDetails(
          baseUrl,
          onChainRegisteredFacetContractAddress,
          network
        )
        let onChainRegisteredFacetContractName =
          onChainRegisteredFacetContractData.ContractName
        if (!onChainRegisteredFacetContractName) {
          // if contract name is null it means that contract is not verified and script couldn't get the name from the explorer. Warn developer
          consola.error(
            `No contract name found for registered facet contract with address ${onChainRegisteredFacetContractAddress} was found in explorer. Please verify contract`
          )
          // now find if there is a name for this address in deploy log
          const deployLogContractName = Object.keys(
            networkDeployLogContracts
          ).find(
            (name) =>
              networkDeployLogContracts[name].toLowerCase() ===
              onChainRegisteredFacetContractAddress.toLowerCase()
          )
          if (!deployLogContractName) {
            consola.error(
              `As contract with address ${onChainRegisteredFacetContractAddress} doesnt exist in deploy log. It cannot be added to deploy log but it should be added. Please verify contract and run script again.`
            )
            continue
          } else {
            consola.info(
              `As contract with address ${onChainRegisteredFacetContractAddress} was found in deploy log (contract name: ${deployLogContractName}) it means that deploy log is up to date for this contract. Contract still needs to be verified`
            )
            onChainRegisteredFacetContractName = deployLogContractName
          }
        }

        const deployLogContractAddress = networkDeployLogContracts[
          onChainRegisteredFacetContractName
        ]
          ? networkDeployLogContracts[
              onChainRegisteredFacetContractName
            ].toLowerCase()
          : null

        // Try to find the contract file in the src folder
        const contractFilePath = findContractFile(
          'src',
          onChainRegisteredFacetContractName
        )
        if (!contractFilePath) {
          consola.error(
            `${onChainRegisteredFacetContractName}: Contract ${onChainRegisteredFacetContractName} registered in the diamond but contract file couldn't be found in src/ folder.`
          )
          // Try to find in the archive folder
          const contractFilePathInArchive = findContractFile(
            'archive',
            onChainRegisteredFacetContractName
          )
          if (contractFilePathInArchive) {
            consola.error(
              `File found in archive/ folder. Please remove facet from diamond.`
            )
          }
          continue
        }

        // Read the contract's source code
        const contractSourceCode = fs.readFileSync(contractFilePath, 'utf8')
        // Extract version from the source code using the custom tag
        const repoVersion = extractVersion(contractSourceCode)
        if (!repoVersion) {
          consola.error(
            `${onChainRegisteredFacetContractName}: Contract ${onChainRegisteredFacetContractName} registered in the diamond but no contract version found in ${contractFilePath}.`
          )
          return null
        }

        consola.info(
          `${onChainRegisteredFacetContractName}: Checking if ${onChainRegisteredFacetContractName} already exists in ${network}.json...`
        )

        if (deployLogContractAddress) {
          // contract with the same name exists in the config file
          if (
            deployLogContractAddress == onChainRegisteredFacetContractAddress
          ) {
            // on chain registered deployed facet contract is the same contract as in deploy log
            // need to only warn if there is newer version in the repo
            if (repoVersion) {
              const onChainRegisteredFacetContractVersion = extractVersion(
                onChainRegisteredFacetContractData.SourceCode
              )

              // warn if there is newer version in the repo
              if (
                isVersionNewer(
                  repoVersion,
                  onChainRegisteredFacetContractVersion
                )
              ) {
                consola.warn(
                  `${onChainRegisteredFacetContractName}: Found newer version in the repo for ${onChainRegisteredFacetContractName} contract. On chain registered facet contract address: ${onChainRegisteredFacetContractAddress} with version ${onChainRegisteredFacetContractVersion}, Repo version ${repoVersion}`
                )
              }
            } else {
              consola.success(
                `${onChainRegisteredFacetContractName}: On chain registered deployed facet contract is the same contract as in deploy log`
              )
              // TODO check if this contract without version can be compared with our repo contract (other way that compering versions) - bytecode? source code?
            }
          } else {
            // on chain registered facet has different address than in deploy log
            consola.error(
              `Contract ${onChainRegisteredFacetContractName}: Address mismatch`
            )
            consola.info(`Checking versions...`)
            if (repoVersion) {
              const deployLogFacetContractData = await fetchContractDetails(
                baseUrl,
                deployLogContractAddress,
                network
              )
              const deployLogFacetContractVersion = extractVersion(
                deployLogFacetContractData.SourceCode
              )
              const onChainRegisteredFacetContractVersion = extractVersion(
                onChainRegisteredFacetContractData.SourceCode
              )

              consola.log('dfsgdfgfdgfd')
              consola.log(onChainRegisteredFacetContractVersion)
              consola.log(deployLogFacetContractVersion)
              if (
                isVersionNewer(
                  onChainRegisteredFacetContractVersion,
                  deployLogFacetContractVersion
                )
              ) {
                // warn if there is newer version in the repo
                consola.warn(
                  `${onChainRegisteredFacetContractName}: Found newer version on chain for ${onChainRegisteredFacetContractName} contract. On chain registered facet contract address: ${onChainRegisteredFacetContractAddress} with version ${showVersion(
                    onChainRegisteredFacetContractVersion
                  )}, Deploy log contract address ${deployLogContractAddress} with version ${showVersion(
                    deployLogFacetContractVersion
                  )}. Updating deploy log ${onChainRegisteredFacetContractName} contract address. ${deployLogContractAddress} -> ${onChainRegisteredFacetContractAddress}`
                )
                networkDeployLogContracts[onChainRegisteredFacetContractName] =
                  onChainRegisteredFacetContractAddress // update deploy log
                if (
                  isVersionNewer(
                    repoVersion,
                    onChainRegisteredFacetContractVersion
                  )
                ) {
                  consola.warn(
                    `${onChainRegisteredFacetContractName}: There is newer version in the repo for ${onChainRegisteredFacetContractName} contract. Onchain version ${showVersion(
                      onChainRegisteredFacetContractVersion
                    )}, repo version ${showVersion(repoVersion)}`
                  )
                }
              } else if (
                isVersionNewer(
                  deployLogFacetContractVersion,
                  onChainRegisteredFacetContractVersion
                )
              ) {
                consola.error(
                  `${onChainRegisteredFacetContractName}: Found newer version on deploy log for ${onChainRegisteredFacetContractName} contract. On chain registered facet contract address: ${onChainRegisteredFacetContractAddress} with version ${showVersion(
                    onChainRegisteredFacetContractVersion
                  )}, Deploy log contract address ${deployLogContractAddress} with version ${deployLogFacetContractVersion}. Please update diamond with newer version in deploy log. ${onChainRegisteredFacetContractAddress} -> ${deployLogContractAddress}`
                )
                if (
                  isVersionNewer(repoVersion, deployLogFacetContractVersion)
                ) {
                  consola.warn(
                    `${onChainRegisteredFacetContractName}: There is newer version in the repo for ${onChainRegisteredFacetContractName} contract. Deploy log version ${showVersion(
                      deployLogFacetContractVersion
                    )}, repo version: ${showVersion(repoVersion)}`
                  )
                }
              } else {
                // TODO check their bytecodes, source codes and creation dates
                consola.error(
                  `${onChainRegisteredFacetContractName}: Found different addresses for on chain and deploy log contract. Both has the same version`
                )
              }
            } else {
              // addresses dont match, contract dont have a version
              // TODO check their bytecodes, source codes and creation dates
              consola.error(
                `${onChainRegisteredFacetContractName}: Found different addresses for on chain and deploy log contract.`
              )
            }
          }
          // // fetching {network}.json facet contract version
          // if (hasVersion) {
          // // fetching config facet contract
          // const deployLogFacetContractData = await fetchContractDetails(
          //   baseUrl,
          //   deployLogContractAddress,
          //   network
          // )
          // const deployLogFacetContractVersion = extractVersion(
          //   deployLogFacetContractData.SourceCode
          // )
          // if (deployLogFacetContractVersion == null) {
          //   consola.error(`Contract ${onChainRegisteredFacetContractName} registered in the diamond but no contract version found in ${contractFilePath}.`)
          //   continue
          // }
          // const onChainRegisteredFacetContractVersion = extractVersion(
          //   onChainRegisteredFacetContractData.SourceCode
          // )
          // if (onChainRegisteredFacetContractVersion == null) {
          //   consola.error(`Contract ${onChainRegisteredFacetContractName} registered in the diamond but no contract version found for address ${onChainRegisteredFacetContractAddress}.`)
          //   continue
          // }
          // // check if on chain registered facet has the same version like contract in deploy log
          // if(compareVersions(
          //   deployLogFacetContractVersion,
          //   onChainRegisteredFacetContractVersion
          // ) == 0) {
          //   consola.warn(
          //     `${onChainRegisteredFacetContractName}: Deploy log contract version . Found newer version in the repo for ${onChainRegisteredFacetContractName} contract. On chain registered facet contract address: ${onChainRegisteredFacetContractAddress} with version ${onChainRegisteredFacetContractVersion}, Repo version ${repoVersion}`
          //   )
          // }
          // // now check if onchain registered facet has the newest version compering to contract code which is in our repo
          // consola.info("here1.5");
          // if (
          //   compareVersions(
          //     repoVersion,
          //     onChainRegisteredFacetContractVersion
          //   )
          // ) { // it means that repo contract has newer version than what is currently deployed and registered on chain
          //   consola.info("here1.5.1");
          //   consola.warn(
          //     `${onChainRegisteredFacetContractName}: Onchain registered facet doesnt have the newest version. Found newer version in the repo for ${onChainRegisteredFacetContractName} contract. On chain registered facet contract address: ${onChainRegisteredFacetContractAddress} with version ${onChainRegisteredFacetContractVersion}, Repo version ${repoVersion}`
          //   )
          //   if (
          //     compareVersions(repoVersion, deployLogFacetContractVersion) == 0
          //   ) {
          //       consola.info("here1.5.1.1");
          //       // equal
          //       consola.error(
          //         `${onChainRegisteredFacetContractName}: But there is POTENTIALLY existing deployed facet but it's not registered ${deployLogContractAddress}`
          //       )
          //     }
          //   } else if (compareVersions(
          //     repoVersion,
          //     onChainRegisteredFacetContractVersion
          //   ) == 0) { // repo version and onchain version are equal
          //     consola.info("here1.6.1");
          //     if(deployLogContractAddress != onChainRegisteredFacetContractAddress) { // deploy log address and on chain registered facet contract address dont match
          //       consola.info("here1.6.1.1");
          //       consola.info(
          //         `${onChainRegisteredFacetContractName}: Updating ${onChainRegisteredFacetContractName}: ${deployLogContractAddress} → ${onChainRegisteredFacetContractAddress}`
          //       )
          //       networkDeployLogContracts[onChainRegisteredFacetContractName] = onChainRegisteredFacetContractAddress
          //     }
          //     else {
          //       consola.info("here1.6.1.2");
          //       consola.info(
          //         `${onChainRegisteredFacetContractName}: On chain and config addresses are the same and they are up to date with repo version. No action needed.${deployLogContractAddress} → ${onChainRegisteredFacetContractAddress}`
          //       )
          //     }
          //   } else {
          //     consola.info("here1.6.2");
          //     consola.error("On chain version is newer than repo version. Super error!")
          //   }
          // }
          // else {
          //   // TODO verification with bytecode if matches
          //   consola.error(
          //     `${onChainRegisteredFacetContractName}: Because contract ${onChainRegisteredFacetContractName} is without versioning it's impossible to verify if it is up to date`
          //   );
          //   if(deployLogContractAddress != onChainRegisteredFacetContractAddress) { // deploy log address and on chain registered facet contract address dont match
          //     consola.error(
          //       `${onChainRegisteredFacetContractName}: On chain registered facet address is different that what is in {network}.json. On chain registered facet contract address: ${onChainRegisteredFacetContractAddress}. Deploy log facet contract address: ${deployLogContractAddress}`
          //     );
          //     const deployLogFacetContractData = await fetchContractDetails(
          //       baseUrl,
          //       deployLogContractAddress,
          //       network
          //     )
          //     if(deployLogFacetContractData.SourceCode == onChainRegisteredFacetContractData.SourceCode) {
          //       // TODO check with repo source code?
          //       consola.info(
          //         `${onChainRegisteredFacetContractName}: But they have the same source codes`
          //       );
          //     } else {
          //       consola.error(
          //         `${onChainRegisteredFacetContractName}: And they have the different source codes`
          //       );
          //     }
          //   }
          //   else {
          //     console.info(`${onChainRegisteredFacetContractName}: All good on chain registered facet address matches what is in {network}.json`)
          //   }
          // }
        } else {
          // {network}.json doesnt have this contract
          consola.warn(
            `${onChainRegisteredFacetContractName}: Found missing ${onChainRegisteredFacetContractName} contract on chain which is missing in deploy log. Adding ${onChainRegisteredFacetContractName} contract with ${onChainRegisteredFacetContractAddress} address to deploy log`
          )
          networkDeployLogContracts[onChainRegisteredFacetContractName] =
            onChainRegisteredFacetContractAddress // update deploy log
          if (repoVersion) {
            // fetching onchain facet contract
            const onChainRegisteredFacetContractVersion = extractVersion(
              onChainRegisteredFacetContractData.SourceCode
            )
            if (
              isVersionNewer(repoVersion, onChainRegisteredFacetContractVersion)
            ) {
              consola.warn(
                `${onChainRegisteredFacetContractName}: There is newer version in the repo for ${onChainRegisteredFacetContractName} contract. Onchain version ${showVersion(
                  onChainRegisteredFacetContractVersion
                )}, repo version ${showVersion(repoVersion)}`
              )
            }
          } else {
            // compare source code / byte code
          }
        }
      }

      fs.writeFileSync(
        networkDeploymentLogPath,
        JSON.stringify(networkDeployLogContracts, null, 2)
      )
      consola.success('Deployment file updated successfully.')
    } catch (error) {
      consola.warn('Skipping facet registration check due to an error:')
      if (error instanceof Error) {
        consola.error(error.message)
      } else {
        consola.error(String(error))
      }
    }
  },
})

function findContractFile(
  baseDir: string,
  contractName: string
): string | null {
  const files = fs.readdirSync(baseDir, { withFileTypes: true })

  for (const file of files) {
    const filePath = path.join(baseDir, file.name)

    if (file.isDirectory()) {
      const result = findContractFile(filePath, contractName)
      if (result) return result
    } else if (file.name === `${contractName}.sol`) {
      return filePath
    }
  }
  return null
}

const fetchContractDetails = async (
  baseUrl: string,
  contractAddress: string,
  network: string
) => {
  await delay(1000)
  consola.log(`\n`)
  consola.info(`Fetching contract details for address: ${contractAddress}`)

  // Retrieve API key
  const apiKeyEnvVar = `${network.toUpperCase()}_ETHERSCAN_API_KEY`
  const apiKey = process.env[apiKeyEnvVar]

  if (!apiKey) {
    throw new Error(
      `Missing API key for ${network}. Ensure it's set in the environment variables.`
    )
  }

  const url = new URL(baseUrl)
  url.searchParams.append('module', 'contract')
  url.searchParams.append('action', 'getsourcecode')
  url.searchParams.append('address', contractAddress)
  url.searchParams.append('apiKey', apiKey)

  const response = await fetch(url.toString())
  const data = await response.json()

  if (data.result.includes('Invalid API Key')) {
    consola.error(data.result)
    return null
  }
  if (
    data.result.includes(
      'Missing or unsupported chainid parameter (required for v2 api)'
    )
  ) {
    consola.warn(
      'Missing or unsupported chainid parameter (required for v2 api). Please see https://api.etherscan.io/v2/chainlist for the list of supported chainids.'
    )
    return null
  }

  return data.result[0] ?? null
}

const fetchContractCreationDetails = async (
  baseUrl: string,
  contractAddresses: string[],
  network: string
) => {
  await delay(1000)
  consola.log(`\n`)
  consola.info(
    `Fetching contracts details for addresses: ${contractAddresses.join(', ')}`
  )

  // Retrieve API key
  const apiKeyEnvVar = `${network.toUpperCase()}_ETHERSCAN_API_KEY`
  const apiKey = process.env[apiKeyEnvVar]

  if (!apiKey) {
    throw new Error(
      `Missing API key for ${network}. Ensure it's set in the environment variables.`
    )
  }

  const url = new URL(baseUrl)
  url.searchParams.append('module', 'contract')
  url.searchParams.append('action', 'getcontractcreation')
  url.searchParams.append('contractaddresses', contractAddresses.join(','))
  url.searchParams.append('apiKey', apiKey)

  const response = await fetch(url.toString())
  const data = await response.json()

  if (data.result.includes('Invalid API Key')) {
    consola.error(data.result)
    return null
  }
  if (
    data.result.includes(
      'Missing or unsupported chainid parameter (required for v2 api)'
    )
  ) {
    consola.warn(
      'Missing or unsupported chainid parameter (required for v2 api). Please see https://api.etherscan.io/v2/chainlist for the list of supported chainids.'
    )
    return null
  }

  return data.result ?? null
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function extractVersion(sourceCode: string): string | null {
  const versionMatch = sourceCode.match(/@custom:version\s+([\d.]+)/)
  return versionMatch ? versionMatch[1] : null
}

function parseVersion(version: string): number[] {
  return version.split('.').map((num) => parseInt(num, 10) || 0)
}

function isVersionNewer(
  versionA: string | null,
  versionB: string | null
): boolean {
  // If versionA is null, we can't consider it newer.
  if (versionA === null) return false
  // If versionB is null, versionA is considered newer.
  if (versionB === null) return true

  const aParts = parseVersion(versionA)
  const bParts = parseVersion(versionB)

  // Compare each segment
  for (let i = 0; i < 3; i++) {
    const a = aParts[i] || 0
    const b = bParts[i] || 0
    if (a > b) return true
    if (a < b) return false
  }
  return false // Versions are equal
}

function showVersion(version: string | null): string {
  return version === null ? "'No version'" : `'${version}'`
}

const checkIsDeployed = async (
  contract: string,
  networkDeployLogContracts: Record<string, Address>,
  publicClient: PublicClient
): Promise<boolean> => {
  const address = networkDeployLogContracts[contract]
  if (!address) return false

  const code = await publicClient.getCode({ address })
  return code !== '0x'
}

runMain(main)
