import { $, spinner, fetch, sleep } from 'zx'
import { consola } from 'consola'
import glob from 'globby'
import process from 'process'
import ethers from 'ethers'
import os from 'os'
import fs from 'fs'

const DEPLOYER_WALLET_ACCOUNT = process.env.DEPLOYER_WALLET_ACCOUNT
const DEPLOYER_WALLET_PASSWORD = process.env.DEPLOYER_WALLET_PASSWORD

// Get JSON from os.homedir()/.foundry/keystores/${DEPLOYER_WALLET_ACCOUNT}.json using fs
const keyStoreJson = fs.readFileSync(
  `${os.homedir()}/.foundry/keystores/${DEPLOYER_WALLET_ACCOUNT}`
)
const DEPLOYER_WALLET = ethers.Wallet.fromEncryptedJsonSync(
  keyStoreJson,
  DEPLOYER_WALLET_PASSWORD
)
const DEPLOYER_WALLET_ADDRESS = DEPLOYER_WALLET.address
const DEPLOYER_PRIVATE_KEY = DEPLOYER_WALLET.privateKey

export default async () => {
  consola.box('Deploy Contract')

  let deployScripts = await glob('script/deploy/facets/**/*.sol')
  // Filter all deployScripts without Facets or Periphery in the path
  deployScripts = deployScripts.filter(
    (c) => c.includes('Deploy') && !c.includes('Base')
  )
  // Extract the filename without path or extension, create an object array that loks like this:
  // [ { name: 'LifiDeploy', path: 'script/deploy/facets/LifiDeploy.sol' } ]
  deployScripts = deployScripts.map((c) => {
    const name = c.split('/').pop().split('.')[0]
    return { name, path: c }
  })
  // Present a list of deployScripts to choose from
  const choice = await consola.prompt('Choose a contract to deploy', {
    type: 'select',
    // Map the object array to a string array of names
    options: deployScripts.map((c) => c.name),
    initial: 0,
  })

  // Get the contract item from the object array
  const deployScript = deployScripts.find((c) => c.name === choice)

  // Using fetch get the LIFI supprted chains from https://li.quest/v1/chains
  // then map the result to an object by extracting chains[i].name and chains[i].metamask.rpcUrls[0]
  let result = await spinner('Fetching LIFI supported chains', async () =>
    (await fetch('https://li.quest/v1/chains')).json()
  )
  const chains = result.chains.map((c) => {
    return { name: c.name, rpcUrl: c.metamask.rpcUrls[0] }
  })

  // Present a list of chains to choose from
  const chainChoice = await consola.prompt('Choose a chain to deploy to', {
    type: 'select',
    options: chains.map((c) => c.name),
    initial: 0,
  })

  // Get the chain item from the object array
  const chain = chains.find((c) => c.name === chainChoice)

  // Run the deploy script with forge e.g await $`forge script script/deploy/facets/DeploySomeScript.sol`
  // TODO: Add the account parameter to the forge script command
  try {
    process.env.PRIVATE_KEY = DEPLOYER_PRIVATE_KEY
    const forgeArgs = [
      `-f`,
      `${chain.rpcUrl}`,
      `--tc`,
      `DeployScript`,
      '--silent',
      '--json',
      '--skip-simulation',
      // '--broadcast',
      '--legacy',
    ]

    const result = await spinner(
      `Running deploy script ${deployScript.name} on ${chain.name}`,
      () => $`forge script ${deployScript.path} ${forgeArgs}`
    )

    // Strip the json result from the first line of resul.stdout
    const jsonResult = JSON.parse(result.stdout.split('\n')[0])

    consola.success(
      `Success!\nContract Deployed at: ${jsonResult.returns[0].value}`
    )
    await updateLogs()
  } catch (e) {
    consola.error(e)
    process.exit(1)
  }
}

const updateLogs = async () => {
  await spinner('Updating logs', async () => {
    await sleep(2000)
  })
  consola.success('Logs updated')
}
