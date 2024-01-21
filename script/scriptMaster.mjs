#!/usr/bin/env zx

import { $ } from 'zx'
import chalk from 'chalk'
import { consola } from 'consola'
import 'dotenv/config'
import process from 'process'

consola.box('LIFI Deployment Manager 1.0.0')

// Warn if production mode is on
if (process.env.PRODUCTION === 'true') {
  consola.warn(
    chalk.yellow(`
  The config environment variable PRODUCTION is set to true
  This means that all changes will be made to the  production
  contracts.
`)
  )
  const cont = await consola.prompt('Continue in production mode?', {
    type: 'confirm',
  })

  if (!cont) {
    consola.info('Exiting...')
    process.exit(0)
  }
}

// Show main menu
const choice = await consola.prompt('Choose an option', {
  type: 'select',
  options: [
    {
      value: 'deploy',
      label: 'Deploy new contract',
    },
    {
      value: 'upgradeDiamond',
      label: 'Add or remove a facet from the LIFI diamond contract',
    },
    { value: 'runTask', label: 'Run a task' },
  ],
  initial: 'deploy',
})

// Run the chosen script
switch (choice) {
  case 'deploy':
    await import('./modules/deployContract.mjs').then((m) => m.default())
    break
  case 'upgradeDiamond':
    await import('./modules/upgradeDiamond.mjs').then((m) => m.default())
    break
  case 'runTask':
    await import('./modules/runTask.mjs').then((m) => m.default())
    break
}
