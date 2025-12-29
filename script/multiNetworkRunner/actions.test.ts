// eslint-disable-next-line import/no-unresolved
import { describe, expect, it, mock } from 'bun:test'

import {
  getAvailableActions,
  resolveActions,
  validateActionRequirements,
} from './actions'

const context = {
  network: {
    id: 'alpha',
    name: 'alpha',
    chainId: 1,
    nativeAddress: '0x0',
    nativeCurrency: 'ETH',
    wrappedNativeAddress: '0x0',
    status: 'active',
    type: 'evm',
    rpcUrl: 'https://rpc',
    verificationType: 'etherscan',
    explorerUrl: '',
    explorerApiUrl: '',
    multicallAddress: '0x0000000000000000000000000000000000000000',
    safeAddress: '',
    deployedWithEvmVersion: 'cancun',
    deployedWithSolcVersion: '0.8.29',
    gasZipChainId: 0,
    isZkEVM: false,
  },
  environment: 'production',
  contract: 'TestContract',
  rpcClient: {},
  rpcEndpoints: [],
  dryRun: false,
}

describe('actions', () => {
  it('lists and resolves actions', () => {
    const actions = getAvailableActions()
    const ids = actions.map((action) => action.id)
    expect(ids).toEqual(['deploy-contract', 'create-proposal'])

    const resolved = resolveActions(['create-proposal'], actions)
    expect(resolved[0]?.id).toBe('create-proposal')

    expect(() => resolveActions(['unknown'], actions)).toThrow('Unknown action')
  })

  it('runs deploy action via runner', async () => {
    const runner = mock(async (command: string) => {
      expect(command).toContain('deploySingleContract')
      return { code: 0 }
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actions = getAvailableActions(runner as any)
    const deploy = actions[0]
    if (!deploy) throw new Error('Deploy action not found')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await deploy.run(context as any)
    expect(result.status).toBe('success')
  })

  it('runs proposal action via runner', async () => {
    const runner = mock(async (command: string) => {
      expect(command).toContain('createMultisigProposalForContract')
      return { code: 0 }
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actions = getAvailableActions(runner as any)
    const proposal = actions[1]
    if (!proposal) throw new Error('Proposal action not found')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await proposal.run(context as any)
    expect(result.status).toBe('success')
  })

  it('fails when runner returns non-zero and skips on dry-run', async () => {
    const runner = mock(async () => ({ code: 1 }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actions = getAvailableActions(runner as any)
    const deploy = actions[0]
    if (!deploy) throw new Error('Deploy action not found')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failed = await deploy.run(context as any)
    expect(failed.status).toBe('failed')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dryRunResult = await deploy.run({ ...(context as any), dryRun: true })
    expect(dryRunResult.status).toBe('skipped')
  })

  it('fails when contract is missing', async () => {
    const runner = mock(async () => ({ code: 0 }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actions = getAvailableActions(runner as any)
    const proposal = actions[1]
    if (!proposal) throw new Error('Proposal action not found')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await proposal.run({
      ...(context as any),
      contract: undefined,
    })
    expect(result.status).toBe('failed')
  })

  it('warns when required contract is missing', () => {
    const actions = getAvailableActions()
    validateActionRequirements(actions, {})
  })
})
