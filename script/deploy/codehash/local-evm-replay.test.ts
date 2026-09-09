/**
 * Covers only the pure half of the adapter. Starting a node is exercised by the
 * end-to-end run recorded in the PR body, because the suite has neither `out/`
 * nor the `anvil` binary to rely on.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { composeCreationCode } from './local-evm-replay'

const CREATION_CODE = '0x60806040'
const ONE_WORD =
  '0000000000000000000000005c7bcd6e7de5423a257d81b442095a1a6ced35c5'

describe('composing the deploy calldata', () => {
  it('appends the encoded args to the creation code', () => {
    const result = composeCreationCode({
      creationCode: CREATION_CODE,
      encodedArgs: ONE_WORD,
    })

    expect(result).toEqual({ ok: true, data: `0x60806040${ONE_WORD}` })
  })

  it('accepts creation code without a 0x prefix', () => {
    const result = composeCreationCode({
      creationCode: '60806040',
      encodedArgs: '',
    })

    expect(result).toEqual({ ok: true, data: '0x60806040' })
  })

  it('lowercases so the caller compares one casing', () => {
    const result = composeCreationCode({
      creationCode: '0x60806040',
      encodedArgs: ONE_WORD.toUpperCase(),
    })

    expect(result).toEqual({ ok: true, data: `0x60806040${ONE_WORD}` })
  })
})

describe('refusing inputs that cannot form deploy calldata', () => {
  it('refuses empty creation code', () => {
    const result = composeCreationCode({
      creationCode: '0x',
      encodedArgs: ONE_WORD,
    })

    expect(result).toEqual({ ok: false, reason: 'creation code is empty' })
  })

  it('refuses creation code that is not whole bytes', () => {
    const result = composeCreationCode({
      creationCode: '0x608',
      encodedArgs: '',
    })

    expect(result).toEqual({
      ok: false,
      reason: 'creation code is not whole bytes',
    })
  })

  it('refuses creation code that is not hex', () => {
    const result = composeCreationCode({
      creationCode: '0x60806zzz',
      encodedArgs: '',
    })

    expect(result).toEqual({ ok: false, reason: 'creation code is not hex' })
  })

  it('refuses args that are not whole 32-byte words', () => {
    const result = composeCreationCode({
      creationCode: CREATION_CODE,
      encodedArgs: ONE_WORD.slice(2),
    })

    expect(result).toEqual({
      ok: false,
      reason: 'encoded constructor args are not whole 32-byte words',
    })
  })

  it('refuses args that are not hex', () => {
    const result = composeCreationCode({
      creationCode: CREATION_CODE,
      encodedArgs: 'z'.repeat(64),
    })

    expect(result).toEqual({
      ok: false,
      reason: 'encoded constructor args are not hex',
    })
  })
})
