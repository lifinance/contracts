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
    })
    expect(String(hex['LiFiTimelockController']).toLowerCase()).toBe(
      TIMELOCK_HEX
    )
    expect(hex['Already']).toBe(REFUND_HEX)
    expect(hex['Version']).toBe(3)
  })

  it('throws on a value that is not a Tron address', () => {
    expect(() =>
      tronDeploymentsAsHex('tron', { Broken: 'Tnot-an-address' })
    ).toThrow()
  })
})

describe('withTronWallets', () => {
  it('lays the Tron wallets over the EVM ones, in hex', () => {
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

  it('throws on a Tron wallet that is not a valid address', () => {
    expect(() =>
      withTronWallets('tron', { tronWallets: { refundWallet: 'Tbroken' } })
    ).toThrow()
  })
})
