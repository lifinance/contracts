import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { frameFault, strip0x } from './hex'

describe('frameFault', () => {
  it('accepts real bytecode with and without a prefix', () => {
    expect(frameFault('0xdeadbeef', 'bytecode')).toBeUndefined()
    expect(frameFault('deadbeef', 'bytecode')).toBeUndefined()
    expect(frameFault('0xDEADBEEF', 'bytecode')).toBeUndefined()
  })

  it('names the caller in the message so a shared guard still reads locally', () => {
    expect(frameFault('', 'bytecode')).toBe('bytecode is empty')
    expect(frameFault('0xabc', 'runtime code')).toBe(
      'runtime code is not whole bytes'
    )
  })

  it('refuses half a byte, because masking it would misalign every offset', () => {
    expect(frameFault('0xabc', 'bytecode')).toBe('bytecode is not whole bytes')
  })

  it('refuses non-hex rather than letting it reach a hash or a value', () => {
    expect(frameFault(`0x${'zz'.repeat(4)}`, 'bytecode')).toBe(
      'bytecode is not hex'
    )
  })

  it('refuses an input that is only a prefix', () => {
    expect(frameFault('0x', 'bytecode')).toBe('bytecode is empty')
  })
})

describe('strip0x', () => {
  it('removes either case of prefix and leaves bare hex alone', () => {
    expect(strip0x('0xabcd')).toBe('abcd')
    expect(strip0x('0Xabcd')).toBe('abcd')
    expect(strip0x('abcd')).toBe('abcd')
  })

  it('does not mistake leading hex digits for a prefix', () => {
    // `0` and `x` only pair up at the very start; `a0x…` is data.
    expect(strip0x('a0xbc')).toBe('a0xbc')
  })
})
