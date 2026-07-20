/**
 * Unit tests for the facet source-side refund reminder (EXSC-624).
 *
 * Focus: detectMsgSenderRefundSites / buildMsgSenderRefundReminder, the pure detection
 * used by deploySingleContract.sh to nudge migration off source-side refunds to msg.sender
 * ([CONV:FACET-REFUNDS], EXSC-622). Covers both refund sites, the multi-line _depositAndSwap
 * call shape used across the facets, the already-migrated refundRecipient form (must NOT flag),
 * and comment-only mentions of msg.sender (must NOT flag).
 */
import {
  describe,
  it,
  expect,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  detectMsgSenderRefundSites,
  buildMsgSenderRefundReminder,
} from './facetRefundReminder'

describe('detectMsgSenderRefundSites', () => {
  it('flags refundExcessNative(payable(msg.sender)) used as a modifier', () => {
    const source = `
      function startBridge(BridgeData calldata _bridgeData)
        external
        payable
        refundExcessNative(payable(msg.sender))
      {}
    `
    const sites = detectMsgSenderRefundSites(source)
    expect(sites.refundExcessNative).toBe(true)
    expect(sites.depositAndSwapLeftover).toBe(false)
  })

  it('flags a multi-line _depositAndSwap call whose leftover receiver is payable(msg.sender)', () => {
    const source = `
      _bridgeData.minAmount = _depositAndSwap(
        _bridgeData.transactionId,
        _bridgeData.minAmount,
        _swapData,
        payable(msg.sender)
      );
    `
    const sites = detectMsgSenderRefundSites(source)
    expect(sites.depositAndSwapLeftover).toBe(true)
    expect(sites.refundExcessNative).toBe(false)
  })

  it('flags the _depositAndSwap overload with a trailing native-reserve arg', () => {
    const source = `
      _bridgeData.minAmount = _depositAndSwap(
        _bridgeData.transactionId,
        _bridgeData.minAmount,
        _swapData,
        payable(msg.sender),
        _nativeReserve
      );
    `
    expect(detectMsgSenderRefundSites(source).depositAndSwapLeftover).toBe(true)
  })

  it('does NOT flag a migrated facet that routes both refunds to refundRecipient', () => {
    const source = `
      function startBridge(BridgeData calldata _bridgeData, XData calldata _xData)
        external
        payable
        refundExcessNative(payable(_xData.refundRecipient))
      {
        _bridgeData.minAmount = _depositAndSwap(
          _bridgeData.transactionId,
          _bridgeData.minAmount,
          _swapData,
          payable(_xData.refundRecipient),
          _xData.nativeFee
        );
      }
    `
    const sites = detectMsgSenderRefundSites(source)
    expect(sites.refundExcessNative).toBe(false)
    expect(sites.depositAndSwapLeftover).toBe(false)
  })

  it('does NOT flag a comment that merely mentions msg.sender', () => {
    const source = `
      // msg.sender may be a relayer or the Permit2Proxy, so refundExcessNative(payable(msg.sender))
      // is unsafe; route to refundRecipient instead. See _depositAndSwap( ... payable(msg.sender)).
      refundExcessNative(payable(_xData.refundRecipient))
    `
    const sites = detectMsgSenderRefundSites(source)
    expect(sites.refundExcessNative).toBe(false)
    expect(sites.depositAndSwapLeftover).toBe(false)
  })

  it('does NOT let a payable(msg.sender) in a later statement leak into a preceding _depositAndSwap', () => {
    const source = `
      _bridgeData.minAmount = _depositAndSwap(
        _bridgeData.transactionId,
        _bridgeData.minAmount,
        _swapData,
        payable(_xData.refundRecipient)
      );
      someOtherCall(payable(msg.sender));
    `
    expect(detectMsgSenderRefundSites(source).depositAndSwapLeftover).toBe(
      false
    )
  })

  it('tolerates extra whitespace inside the refund patterns', () => {
    const source = `refundExcessNative( payable(  msg.sender ) )`
    expect(detectMsgSenderRefundSites(source).refundExcessNative).toBe(true)
  })
})

describe('buildMsgSenderRefundReminder', () => {
  it('returns null when the source has no source-side refund to msg.sender', () => {
    expect(
      buildMsgSenderRefundReminder('MigratedFacet', 'contract MigratedFacet {}')
    ).toBeNull()
  })

  it('names the facet, both detected sites, the ticket and the convention anchor', () => {
    const source = `
      refundExcessNative(payable(msg.sender))
      _depositAndSwap(id, min, swaps, payable(msg.sender));
    `
    const message = buildMsgSenderRefundReminder('AcrossFacet', source)
    expect(message).not.toBeNull()
    expect(message).toContain('AcrossFacet')
    expect(message).toContain('refundExcessNative(payable(msg.sender))')
    expect(message).toContain('_depositAndSwap leftovers')
    expect(message).toContain('EXSC-622')
    expect(message).toContain('[CONV:FACET-REFUNDS]')
    expect(message).toContain('refundRecipient')
  })

  it('lists only the site that actually matched', () => {
    const message = buildMsgSenderRefundReminder(
      'DepositOnlyFacet',
      '_depositAndSwap(id, min, swaps, payable(msg.sender));'
    )
    expect(message).toContain('_depositAndSwap leftovers')
    expect(message).not.toContain('refundExcessNative(payable(msg.sender))')
  })
})
