import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  buildDependencyReminder,
  collectTransitiveDependents,
  type IDependencyEntry,
} from './contractDependencyReminder'

const REQUIREMENTS: Record<string, IDependencyEntry> = {
  Executor: { contractAddresses: { ERC20Proxy: {} } },
  ReceiverAcrossV4: { contractAddresses: { Executor: {} } },
  ReceiverStargateV2: { contractAddresses: { Executor: {} } },
  SomeFacet: {},
}

describe('collectTransitiveDependents', () => {
  it('finds direct dependents', () => {
    expect(collectTransitiveDependents('Executor', REQUIREMENTS)).toEqual([
      { contract: 'ReceiverAcrossV4', via: [] },
      { contract: 'ReceiverStargateV2', via: [] },
    ])
  })

  it('walks the graph transitively with the path recorded', () => {
    expect(collectTransitiveDependents('ERC20Proxy', REQUIREMENTS)).toEqual([
      { contract: 'Executor', via: [] },
      { contract: 'ReceiverAcrossV4', via: ['Executor'] },
      { contract: 'ReceiverStargateV2', via: ['Executor'] },
    ])
  })

  it('returns nothing for a contract nobody depends on', () => {
    expect(collectTransitiveDependents('SomeFacet', REQUIREMENTS)).toEqual([])
  })

  it('is cycle-safe', () => {
    const cyclic = {
      A: { contractAddresses: { B: {} } },
      B: { contractAddresses: { A: {} } },
    }

    // A is the contract being redeployed, so it is never reported as its own dependent.
    expect(collectTransitiveDependents('A', cyclic)).toEqual([
      { contract: 'B', via: [] },
    ])
  })
})

describe('updatable dependency edges', () => {
  // These dependents can repoint the address after deployment, so a redeploy of the dependency
  // must not tell the deployer to redeploy them.
  const UPDATABLE = {
    LiFiDiamond: { contractAddresses: { DiamondCutFacet: {} } },
    LiFiDiamondImmutable: { contractAddresses: { DiamondCutFacet: {} } },
    LiFiTimelockController: { contractAddresses: { LiFiDiamond: {} } },
  }

  it('drops the diamond -> DiamondCutFacet edge', () => {
    expect(collectTransitiveDependents('DiamondCutFacet', UPDATABLE)).toEqual(
      []
    )
  })

  it('drops the timelock -> LiFiDiamond edge', () => {
    expect(collectTransitiveDependents('LiFiDiamond', UPDATABLE)).toEqual([])
  })

  it('still reports a same-named dependent when the edge is not excluded', () => {
    const graph = {
      LiFiTimelockController: { contractAddresses: { Executor: {} } },
    }

    expect(collectTransitiveDependents('Executor', graph)).toEqual([
      { contract: 'LiFiTimelockController', via: [] },
    ])
  })
})

describe('buildDependencyReminder', () => {
  const ADDR = '0x1111111111111111111111111111111111111111'

  it('lists only dependents deployed on this network', () => {
    const reminder = buildDependencyReminder(
      'Executor',
      'mainnet',
      { ReceiverAcrossV4: ADDR },
      REQUIREMENTS
    )

    expect(reminder).toContain('Redeploying Executor')
    expect(reminder).toContain('ReceiverAcrossV4')
    expect(reminder).not.toContain('ReceiverStargateV2')
  })

  it('shows the transitive path for indirect dependents', () => {
    const reminder = buildDependencyReminder(
      'ERC20Proxy',
      'mainnet',
      { Executor: ADDR, ReceiverAcrossV4: ADDR },
      REQUIREMENTS
    )

    expect(reminder).toContain('Executor')
    expect(reminder).toContain('ReceiverAcrossV4 (via Executor)')
  })

  it('returns null when no dependent is deployed', () => {
    expect(
      buildDependencyReminder('Executor', 'mainnet', {}, REQUIREMENTS)
    ).toBeNull()
  })

  it('returns null for a contract nobody depends on', () => {
    expect(
      buildDependencyReminder(
        'SomeFacet',
        'mainnet',
        { ReceiverAcrossV4: ADDR },
        REQUIREMENTS
      )
    ).toBeNull()
  })
})

describe('real deployRequirements.json reverse graph', () => {
  it('Executor dependents include every coupled receiver with an entry', () => {
    const dependents = collectTransitiveDependents('Executor').map(
      (d) => d.contract
    )

    expect(dependents).toContain('ReceiverAcrossV4')
    expect(dependents).toContain('ReceiverStargateV2')
    expect(dependents).toContain('ReceiverChainflip')
    expect(dependents).toContain('ReceiverOIF')
  })

  it('excludes DiamondCutFacet: a diamond replaces it with an ordinary cut', () => {
    expect(collectTransitiveDependents('DiamondCutFacet')).toEqual([])
  })

  it('excludes the timelock, which can repoint its diamond via setDiamondAddress', () => {
    expect(
      collectTransitiveDependents('LiFiDiamond').map((d) => d.contract)
    ).not.toContain('LiFiTimelockController')
  })

  it('covers the diamond bindings the requirements file omits', () => {
    const dependents = collectTransitiveDependents('LiFiDiamond').map(
      (d) => d.contract
    )

    expect(dependents).toContain('Permit2Proxy')
    expect(dependents).toContain('GasZipPeriphery')
    expect(dependents).not.toContain('LiFiTimelockController')
  })

  it('does not promise a health check for the diamond edges', () => {
    const reminder = buildDependencyReminder('LiFiDiamond', 'mainnet', {
      Permit2Proxy: '0x1111111111111111111111111111111111111111',
    })

    expect(reminder).toContain('Permit2Proxy')
    expect(reminder).not.toContain('health check')
  })

  it('keeps every genuine cascade edge in the real graph', () => {
    const executorDependents = collectTransitiveDependents('Executor').map(
      (d) => d.contract
    )

    expect(executorDependents).not.toContain('LiFiDiamond')
    expect(executorDependents.length).toBeGreaterThanOrEqual(4)
  })

  it('ERC20Proxy dependents include the receivers transitively via Executor', () => {
    const dependents = collectTransitiveDependents('ERC20Proxy')
    const receiver = dependents.find((d) => d.contract === 'ReceiverAcrossV4')

    expect(dependents.map((d) => d.contract)).toContain('Executor')
    expect(receiver?.via).toEqual(['Executor'])
  })
})

describe('CLI smoke test', () => {
  // deploySingleContract.sh runs this CLI behind `2>/dev/null || true`, so a crash (bad import,
  // syntax error) would silently disable the reminder forever. Spawning the real entry point
  // proves it executes and prints for a known dependent in the deploy log.
  const cliPath = join(import.meta.dir, 'contractDependencyReminder.ts')

  it('exits 0 and prints the reminder when a deployed dependent exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'dependency-cli-'))
    mkdirSync(join(root, 'deployments'))
    writeFileSync(
      join(root, 'deployments', 'smokenet.json'),
      JSON.stringify({
        ReceiverAcrossV4: '0x1111111111111111111111111111111111111111',
      })
    )

    const result = Bun.spawnSync(
      [process.execPath, cliPath, 'Executor', 'smokenet', 'production'],
      { cwd: root }
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('ReceiverAcrossV4')
  })

  it('exits 0 and prints nothing without arguments', () => {
    const result = Bun.spawnSync([process.execPath, cliPath])

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe('')
  })
})
