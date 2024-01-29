import { $, spinner, glob, os, fs, retry, chalk } from 'zx'
import { consola } from 'consola'
import process from 'process'
import { ethers } from 'ethers'
import { Chain } from 'viem'

const DEPLOYER_WALLET_ACCOUNT = process.env.DEPLOYER_WALLET_ACCOUNT
const DEPLOYER_WALLET_PASSWORD = process.env.DEPLOYER_WALLET_PASSWORD

// Get JSON from os.homedir()/.foundry/keystores/${DEPLOYER_WALLET_ACCOUNT}.json using fs
const keyStoreJson = fs.readFileSync(
  `${os.homedir()}/.foundry/keystores/${DEPLOYER_WALLET_ACCOUNT}`
)
const DEPLOYER_WALLET = ethers.Wallet.fromEncryptedJsonSync(
  keyStoreJson.toString(),
  DEPLOYER_WALLET_PASSWORD as string
)
const DEPLOYER_WALLET_ADDRESS = DEPLOYER_WALLET.address

type ScriptsOption = {
  name: string
  path: string
}

export default async () => {
  consola.box('Deploy Contract')

  let deployScripts = await glob('script/deploy/facets/*.sol')
  // Filter all deployScripts without Facets or Periphery in the path

  deployScripts = deployScripts.filter(
    (c) => c.includes('Deploy') && c.includes('2')
  )
  // Extract the filename without path or extension, create an object array that loks like this:
  // [ { name: 'LifiDeploy', path: 'script/deploy/facets/LifiDeploy.sol' } ]
  const options = deployScripts.map((c) => {
    const name = c.split('/').pop()?.split('.')[0]
    return { name, path: c }
  })
  // Present a list of deployScripts to choose from
  const choice = await consola.prompt('Choose a contract to deploy', {
    type: 'select',
    // Map the object array to a string array of names
    options: options.map((c) => c.name),
  })

  // Get the contract item from the object array
  const deployScript = deployScripts.find((c) => c.name === choice)
  // Strip 'Deploy' and '2' from the name to get the contract name
  const contractName = deployScript.name.replace('Deploy', '').slice(0, -1)

  // Read the ./networks file and add each line to an array of chains and remove any empty lines
  const chains = (await fs.readFile('./networks', 'utf8'))
    .split('\n')
    .filter((c) => c)

  // Present a list of chains to choose from
  const chainChoice = await consola.prompt('Choose a chain to deploy to', {
    type: 'select',
    options: chains,
  })

  // Get the chain item from the object array
  const chain: Chain = (await import('viem/chains'))[chainChoice] as Chain

  const rpcUrl = chain.rpcUrls.default.http[0]

  // Run the deploy script with forge e.g await $`forge script script/deploy/facets/DeploySomeScript.sol`
  try {
    // This calls the run() function of the deploy script with the following arguments:
    // - deployer wallet address
    // - create3 factory address
    // - chain name
    // - salt
    // - production?
    const runCallData = await spinner(
      'Setting up deploy parameters...',
      () =>
        $`cast calldata "run(address,address,string,string,bool)" ${DEPLOYER_WALLET_ADDRESS} ${
          process.env.CREATE3_FACTORY_ADDRESS
        } ${chainChoice} "${process.env.SALT || ''}" ${
          process.env.PRODUCTION ? true : false
        }`
    )

    // Setup the forge arguments
    const forgeArgs = [
      `-f`,
      `${rpcUrl}`,
      `--tc`,
      `${deployScript?.name}`,
      '--sig',
      `${runCallData.stdout.trim()}`,
      '--account',
      `${DEPLOYER_WALLET_ACCOUNT}`,
      '--password',
      `${DEPLOYER_WALLET_PASSWORD}`,
      '--silent',
      '--json',
      '--skip-simulation',
      '-vvvv',
      // '--broadcast',
      '--legacy',
    ]

    if (!deployScript || !chain) {
      return
    }

    // Run the forge script
    const result = await spinner(
      `Running deploy script ${deployScript.path} on ${chain.name} from ${DEPLOYER_WALLET_ADDRESS}`,
      async () =>
        await retry(
          parseInt(process.env.MAX_RETRIES as string),
          '1s',
          () => $`forge script ${deployScript.path} ${forgeArgs}`
        )
    )

    // Strip the json from the first line of result.stdout
    const jsonResult = JSON.parse(result.stdout.split('\n')[0])

    const contractAddress = jsonResult.returns.deployed.value
    const constructorArgs = jsonResult.returns.constructorArgs.value

    consola.success(
      `Success! Contract Deployed at: ${jsonResult.returns.deployed.value}`
    )

    // Get the version from the contract
    const version = await getContractVersion(contractName)

    // Get the optimizer runs from the compiled contract
    const meta = await spinner(
      'Fetching contract metadata...',
      () => $`forge inspect ${contractName} metadata`
    )
    const metaJson = JSON.parse(meta.stdout)
    const optimizerRuns = metaJson.settings.optimizer.runs.toString()

    // Update logs
    await updateLogs(
      chainChoice,
      contractName,
      contractAddress,
      constructorArgs,
      version,
      optimizerRuns
    )
  } catch (e) {
    consola.error(e)
    process.exit(1)
  }
}

const getContractVersion = async (contractName: string) => {
  // If name contains 'Facet' path is './src/Facets/<contractName>.sol'
  // else path is './src/Periphery/<contractName>.sol'
  const path = contractName.includes('Facet')
    ? './src/Facets/'
    : './src/Periphery/'
  const contract = await fs.readFile(`${path}${contractName}.sol`, 'utf8')

  // extract the version from the contract where the version is declared as follows: '@custom:version <version>'
  const version = contract.match(/@custom:version (.*)/)[1]
  return version
}
const updateLogs = async (
  network: string,
  contractName: string,
  address: string,
  constructorArgs: string,
  version: string,
  optimizerRuns: string
) => {
  await spinner('Updating logs', async () => {
    // Add or update the key"<contractName>": "<address>" the json in ./deployments/<network>.json
    const deployments = JSON.parse(
      await fs.readFile(`./deployments/${network}.json`, 'utf8')
    )
    deployments[contractName] = address
    await fs.writeFile(
      `./deployments/${network}.json`,
      JSON.stringify(deployments, null, 2)
    )
  })

  const env = process.env.PRODUCTION ? 'production' : 'staging'

  // Setup log record
  const log = {
    ADDRESS: address,
    OPTIMIZER_RUNS: optimizerRuns,
    // Time format YYYY-MM-DD HH:MM:SS
    TIMESTAMP: new Date().toISOString().replace('T', ' ').split('.')[0],
    CONSTRUCTOR_ARGS: constructorArgs,
    SALT: process.env.SALT || '',
    VERIFIED: false,
  }

  // Add the log record to ./deployments/_deployments_log_file.json at the key <contractName>.<network>.<env>.<version>
  const logFile = JSON.parse(
    await fs.readFile(`./deployments/_deployments_log_file.json`, 'utf8')
  )
  if (!logFile[contractName]) {
    logFile[contractName] = {}
  }
  if (!logFile[contractName][network]) {
    logFile[contractName][network] = {}
  }
  if (!logFile[contractName][network][env]) {
    logFile[contractName][network][env] = {}
  }
  if (!logFile[contractName][network][env][version]) {
    logFile[contractName][network][env][version] = {}
  }
  // Search the items in <contractName>.<network>.<env>.<version>[] and if there is an entry with the same ADRESS as log.ADDRESS then skip
  const logFileItem = logFile[contractName][network][env][version].find(
    (c) => c.ADDRESS === log.ADDRESS
  )
  if (logFileItem) {
    consola.warn(
      `Log for ${chalk.blue(contractName)} already exists at ${chalk.blue(
        log.ADDRESS
      )} > ${chalk.blue(network)} > ${chalk.blue(env)} > ${chalk.blue(version)}`
    )
    return
  }
  logFile[contractName][network][env][version].push(log)
  await fs.writeFile(
    `./deployments/_deployments_log_file.json`,
    JSON.stringify(logFile, null, 2)
  )

  consola.success('Logs updated')
}
