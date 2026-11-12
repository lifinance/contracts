import { describe, expect, it } from 'bun:test'

import { tronDeploymentsAsHex, withTronWallets } from './timelock-watcher-tron'

const TIMELOCK_BASE58 = 'TBzBFjsCh3LJh9avAKy9oF3StZMn4hUBhu'
const TIMELOCK_HEX = '0x161f35951702e93ffee662ed16fb538c283462a5'
const REFUND_BASE58 = 'TBvVg3Aam5QP2XE3XCatgatjefXvsYf6yD'
const REFUND_HEX = '0x156cebba59deb2cb23742f70dcb0a11cc775591f'

describe('tronDeploymentsAsHex', () => {
  it('spells every base58 address as hex and leaves other values alone', () => {
    const hex = tronDeploymentsAsHex('tron', {
      LiFiTimelockController: TIMELOCK_BASE58,
      Already: REFUND_HEX,
      Version: 3,
      Label: 'Timelock',
    })
    expect(String(hex['LiFiTimelockController']).toLowerCase()).toBe(
      TIMELOCK_HEX
    )
    expect(hex['Already']).toBe(REFUND_HEX)
    expect(hex['Version']).toBe(3)
    expect(hex['Label']).toBe('Timelock')
  })

  it('throws on a base58-shaped value whose checksum fails', () => {
    const broken = `${TIMELOCK_BASE58.slice(0, -1)}v`
    expect(() => tronDeploymentsAsHex('tron', { Broken: broken })).toThrow()
  })
})

describe('withTronWallets', () => {
  it('replaces every EVM wallet with its Tron counterpart, in hex', () => {
    const config = withTronWallets('tron', {
      refundWallet: '0x0000000000000000000000000000000000000001',
      safeOwners: ['0x0000000000000000000000000000000000000002'],
      tronWallets: { refundWallet: REFUND_BASE58 },
    })
    expect(String(config['refundWallet']).toLowerCase()).toBe(REFUND_HEX)
    expect(config['safeOwners']).toEqual([
      '0x0000000000000000000000000000000000000002',
    ])
  })

  it('throws when the config has no tronWallets', () => {
    expect(() => withTronWallets('tron', {})).toThrow('no tronWallets')
  })

  it('throws when tronWallets lacks a wallet the EVM config names', () => {
    expect(() =>
      withTronWallets('tron', {
        refundWallet: '0x0000000000000000000000000000000000000001',
        withdrawWallet: '0x0000000000000000000000000000000000000003',
        tronWallets: { refundWallet: REFUND_BASE58 },
      })
    ).toThrow('tronWallets.withdrawWallet')
  })

  it('throws on a Tron wallet that is not a valid address', () => {
    expect(() =>
      withTronWallets('tron', {
        refundWallet: '0x0000000000000000000000000000000000000001',
        tronWallets: { refundWallet: 'Tbroken' },
      })
    ).toThrow('tronWallets.refundWallet')
  })
})
