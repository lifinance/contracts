import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it, mock } from 'bun:test'

import { executeGroups } from './executor'
import { hashActionParams, loadTrackingStore } from './tracking'
import type { INetworkConfig } from './types'

const makeNetwork = (id: string): INetworkConfig => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  id: id as any,
  name: id,
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
})

const createTracking = (
  actions: Array<{ id: string; label: string }>,
  networks: string[]
) => {
  const dir = mkdtempSync(join(tmpdir(), 'executor-test-'))
  const filePath = join(dir, 'tracking.json')
  const actionMeta = actions.map((action) => ({
    id: action.id,
    label: action.label,
    paramsHash: hashActionParams({
      actionId: action.id,
      contract: 'Test',
      environment: 'production',
    }),
  }))

  const store = loadTrackingStore({
    path: filePath,
    environment: 'production',
    actions: actionMeta,
    networks,
  })

  const hashMap = new Map<string, string>()
  for (const action of actionMeta) {
    hashMap.set(action.id, action.paramsHash)
  }

  return { dir, store, hashMap }
}

describe('executor', () => {
  it('executes actions across groups and updates tracking', async () => {
    const networks = [
      makeNetwork('alpha'),
      makeNetwork('beta'),
      makeNetwork('gamma'),
    ]

    const actions = [
      {
        id: 'success',
        label: 'Success',
        isTx: true,
        requiresContract: false,
        run: async () => ({ status: 'success' }),
      },
      {
        id: 'failed',
        label: 'Failed',
        isTx: false,
        requiresContract: false,
        run: async () => ({ status: 'failed', error: 'boom' }),
      },
      {
        id: 'skipped',
        label: 'Skipped',
        isTx: false,
        requiresContract: false,
        run: async () => ({ status: 'skipped' }),
      },
      {
        id: 'throws',
        label: 'Throws',
        isTx: false,
        requiresContract: false,
        run: async () => {
          throw new Error('explode')
        },
      },
      {
        id: 'skip-existing',
        label: 'SkipExisting',
        isTx: false,
        requiresContract: false,
        run: async () => ({ status: 'success' }),
      },
    ]

    const { dir, store, hashMap } = createTracking(
      actions,
      networks.map((net) => net.id)
    )
    const skipExistingHash = hashMap.get('skip-existing')
    if (!skipExistingHash) throw new Error('Missing hash for skip-existing')
    const skipKey = store.getActionKey('skip-existing', skipExistingHash)
    store.finishAction('alpha', skipKey, 'success')

    const foundryManager = {
      applyLondonProfile: mock(async () => {}),
      ensurePrimaryProfile: mock(async () => {}),
    }

    const rpcPool = {
      getPublicClient: mock(async () => ({})),
      describeEndpoints: mock(async () => []),
    }

    const network0 = networks[0]
    const network1 = networks[1]
    const network2 = networks[2]
    if (!network0 || !network1 || !network2) throw new Error('Missing networks')

    await executeGroups(
      [
        { name: 'primary', networks: [network0] },
        { name: 'london', networks: [network1] },
        { name: 'zkevm', networks: [network2] },
      ],
      networks,
      {
        environment: 'production',
        contract: 'Test',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        actions: actions as any,
        actionParamsHash: hashMap,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rpcPool: rpcPool as any,
        trackingStore: store,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        foundryManager: foundryManager as any,
        networkConcurrency: 2,
        allowNonTxParallel: true,
        dryRun: false,
      }
    )

    const successHash = hashMap.get('success')
    const failedHash = hashMap.get('failed')
    const skippedHash = hashMap.get('skipped')
    const throwsHash = hashMap.get('throws')
    if (!successHash || !failedHash || !skippedHash || !throwsHash) {
      throw new Error('Missing hash for action')
    }
    const successKey = store.getActionKey('success', successHash)
    const failedKey = store.getActionKey('failed', failedHash)
    const skippedKey = store.getActionKey('skipped', skippedHash)
    const throwsKey = store.getActionKey('throws', throwsHash)

    expect(store.getEntry('alpha', successKey).status).toBe('success')
    expect(store.getEntry('alpha', failedKey).status).toBe('failed')
    expect(store.getEntry('alpha', skippedKey).status).toBe('skipped')
    expect(store.getEntry('alpha', throwsKey).status).toBe('failed')

    expect(foundryManager.applyLondonProfile).toHaveBeenCalled()
    expect(foundryManager.ensurePrimaryProfile).toHaveBeenCalled()

    rmSync(dir, { recursive: true, force: true })
  })

  it('marks actions failed when rpc setup fails', async () => {
    const network = makeNetwork('alpha')
    const actions = [
      {
        id: 'success',
        label: 'Success',
        isTx: true,
        requiresContract: false,
        run: async () => ({ status: 'success' }),
      },
    ]

    const { dir, store, hashMap } = createTracking(actions, [network.id])

    const foundryManager = {
      applyLondonProfile: mock(async () => {}),
      ensurePrimaryProfile: mock(async () => {}),
    }

    const rpcPool = {
      getPublicClient: mock(async () => {
        throw new Error('rpc down')
      }),
      describeEndpoints: mock(async () => []),
    }

    await executeGroups(
      [{ name: 'primary', networks: [network as INetworkConfig] }],
      [network as INetworkConfig],
      {
        environment: 'production',
        contract: 'Test',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        actions: actions as any,
        actionParamsHash: hashMap,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rpcPool: rpcPool as any,
        trackingStore: store,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        foundryManager: foundryManager as any,
        networkConcurrency: 1,
        allowNonTxParallel: false,
        dryRun: false,
      }
    )

    const successHash = hashMap.get('success')
    if (!successHash) throw new Error('Missing hash for success')
    const successKey = store.getActionKey('success', successHash)
    expect(store.getEntry('alpha', successKey).status).toBe('failed')

    rmSync(dir, { recursive: true, force: true })
  })

  it('does not update tracking during dry-run', async () => {
    const network = makeNetwork('alpha')
    const actions = [
      {
        id: 'success',
        label: 'Success',
        isTx: true,
        requiresContract: false,
        run: async () => ({ status: 'success' }),
      },
    ]

    const { dir, store, hashMap } = createTracking(actions, [network.id])

    const foundryManager = {
      applyLondonProfile: mock(async () => {}),
      ensurePrimaryProfile: mock(async () => {}),
    }

    const rpcPool = {
      getPublicClient: mock(async () => ({})),
      describeEndpoints: mock(async () => []),
    }

    await executeGroups(
      [{ name: 'primary', networks: [network as INetworkConfig] }],
      [network as INetworkConfig],
      {
        environment: 'production',
        contract: 'Test',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        actions: actions as any,
        actionParamsHash: hashMap,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rpcPool: rpcPool as any,
        trackingStore: store,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        foundryManager: foundryManager as any,
        networkConcurrency: 1,
        allowNonTxParallel: false,
        dryRun: true,
      }
    )

    const successHash = hashMap.get('success')
    if (!successHash) throw new Error('Missing hash for success')
    const successKey = store.getActionKey('success', successHash)
    expect(store.getEntry('alpha', successKey).status).toBe('pending')

    rmSync(dir, { recursive: true, force: true })
  })
})
