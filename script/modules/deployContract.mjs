import { $, spinner, fetch } from 'zx'
import { consola } from 'consola'
import glob from 'globby'
import process from 'process'

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
  let result = await (await fetch('https://li.quest/v1/chains')).json()
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
    await spinner(
      `Running deploy script ${deployScript.name} on ${chain.name}`,
      () => $`forge script ${deployScript.path} --rpc-url ${chain.rpcUrl}`
    )
  } catch (e) {
    consola.error(e)
    process.exit(1)
  }
}
