/**
 * `resolveBroadcastCall` against real TronWeb contract wrappers, because the
 * property under test is agreement with TronWeb's own selector formatting: a
 * hand-written fake would be asserting a second implementation of the very
 * canonicalisation the helper exists to avoid re-implementing.
 *
 * `TronWeb` and `Contract` are constructed, never called, so nothing here
 * reaches a node; the host is `.invalid`, which never resolves.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { Contract, TronWeb } from 'tronweb'

import { resolveBroadcastCall, type IAbiFunctionEntry } from './abi'

const CONTRACT = 'TAuErcuAtU6BPt6YwL51JZ4RpDCPQASCU2'
const tronWeb = new TronWeb({ fullHost: 'https://tron.invalid' })

const fn = (
  name: string,
  inputs: string[],
  type = 'function'
): IAbiFunctionEntry => ({
  type,
  name,
  inputs: inputs.map((inputType) => ({ type: inputType })),
})

/** A wrapper built exactly as the send path builds it, from an ABI. */
const wrapperFor = (abi: IAbiFunctionEntry[]): Contract =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new Contract(tronWeb as any, abi as any, CONTRACT)

const resolve = (
  abi: IAbiFunctionEntry[],
  name: string,
  typed: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any => resolveBroadcastCall(wrapperFor(abi) as any, name, typed)

describe('resolveBroadcastCall', () => {
  it('prices the canonical selector for a non-canonical spelling', () => {
    // `uint` is a valid way to type `uint256` and hashes to a different
    // selector (0x6cb927d8 against 0xa9059cbb). Built from the typed string,
    // the estimate simulated a function the contract does not have; the
    // simulation reverted and the guard refused a send that had worked.
    const abi = [fn('transfer', ['address', 'uint256'])]

    const resolved = resolve(abi, 'transfer', ['address', 'uint'])

    expect(resolved.functionSelector).toBe('transfer(address,uint256)')
    expect(resolved.functionSelector).not.toBe('transfer(address,uint)')
  })

  it('agrees with the selector the broadcast is bound to', () => {
    // The one invariant that matters: whatever the operator typed, the estimate
    // and `contract[name](...)` must price and send the same function.
    const abi = [fn('transfer', ['address', 'uint256'])]
    const wrapper = wrapperFor(abi)

    const resolved = resolveBroadcastCall(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wrapper as any,
      'transfer',
      ['address', 'uint']
    )

    expect(resolved.functionSelector).toBe(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (wrapper.methodInstances as any)['transfer'].functionSelector
    )
  })

  it('canonicalises an ABI that itself carries the loose spelling', () => {
    // The signature path's fallback builds a minimal ABI out of the typed
    // types, so the ABI entry says `uint` too — and TronWeb still formats the
    // selector through ethers, so reading the entry's types back out would have
    // reproduced the bug one layer down.
    const abi = [fn('transfer', ['address', 'uint'])]

    const resolved = resolve(abi, 'transfer', ['address', 'uint'])

    expect(resolved.functionSelector).toBe('transfer(address,uint256)')
    // The parameter types stay the ABI's own, which is what the broadcast
    // encodes with, so estimate and send encode identically.
    expect(resolved.inputTypes).toEqual(['address', 'uint'])
  })

  it('returns the ABI entry input types, in order', () => {
    const abi = [fn('grantRole', ['bytes32', 'address'])]

    expect(
      resolve(abi, 'grantRole', ['bytes32', 'address']).inputTypes
    ).toEqual(['bytes32', 'address'])
  })

  it('resolves a no-argument function', () => {
    expect(resolve([fn('pause', [])], 'pause', []).functionSelector).toBe(
      'pause()'
    )
    expect(resolve([fn('pause', [])], 'pause', []).inputTypes).toEqual([])
  })

  it('accepts the capitalised `Function` type a Tron node returns', () => {
    const abi = [fn('pause', [], 'Function')]

    expect(resolve(abi, 'pause', []).functionSelector).toBe('pause()')
  })

  it('refuses a function the ABI in use does not declare', () => {
    const abi = [fn('pause', [])]

    expect(() => resolve(abi, 'unpause', [])).toThrow(
      /declares no function named "unpause"/
    )
  })

  it('ignores an event of the same name when deciding a function exists', () => {
    // Paired with the case above: absence has to be absence of a *function*,
    // not of any ABI entry.
    const abi = [{ type: 'event', name: 'Paused', inputs: [] }, fn('pause', [])]

    expect(() => resolve(abi, 'Paused', [])).toThrow(/declares no function/)
    expect(resolve(abi, 'pause', []).functionSelector).toBe('pause()')
  })

  it('refuses when the ABI entry takes a different number of arguments', () => {
    const abi = [fn('transfer', ['address', 'uint256'])]

    expect(() => resolve(abi, 'transfer', ['address'])).toThrow(
      /different number of arguments/
    )
  })

  it('refuses an overload the bare name would not reach, naming the candidates', () => {
    // TronWeb binds `contract[name]` to the last entry of that name, so asking
    // for the first one cannot be honoured — and guessing would price one
    // function and send another.
    const abi = [fn('withdraw', ['uint256']), fn('withdraw', ['address'])]

    const attempt = (): unknown => resolve(abi, 'withdraw', ['uint256'])

    expect(attempt).toThrow(/Refusing to guess/)
    expect(attempt).toThrow(/withdraw\(uint256\), withdraw\(address\)/)
  })

  it('allows the overload the bare name does reach', () => {
    // Paired with the refusal above, so that assertion is not passing on any
    // overloaded ABI at all.
    const abi = [fn('withdraw', ['uint256']), fn('withdraw', ['address'])]

    expect(resolve(abi, 'withdraw', ['address']).functionSelector).toBe(
      'withdraw(address)'
    )
  })

  it('refuses an overload the typed arity cannot pick apart', () => {
    const abi = [fn('set', ['uint256']), fn('set', ['address'])]

    expect(() => resolve(abi, 'set', ['bytes32'])).toThrow(/Refusing to guess/)
  })
})
