import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { parseTroncastFacetsOutput } from './parseTroncastFacetsOutput'

const FACET_A = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'
const FACET_B = 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8'

describe('parseTroncastFacetsOutput', () => {
  it('parses two facets each with their selectors', () => {
    const output = `[[${FACET_A} [0x1f931c1c 0xcdffacc6]] [${FACET_B} [0x7a0ed627]]]`

    expect(parseTroncastFacetsOutput(output)).toEqual([
      [FACET_A, ['0x1f931c1c', '0xcdffacc6']],
      [FACET_B, ['0x7a0ed627']],
    ])
  })

  it('returns an empty selector list for a facet with no selectors', () => {
    const output = `[[${FACET_A} []] [${FACET_B} [0x7a0ed627]]]`

    expect(parseTroncastFacetsOutput(output)).toEqual([
      [FACET_A, []],
      [FACET_B, ['0x7a0ed627']],
    ])
  })

  it('ignores whitespace surrounding the output', () => {
    const output = `\n  [[${FACET_A} [0x1f931c1c 0xcdffacc6]]]  \n`

    expect(parseTroncastFacetsOutput(output)).toEqual([
      [FACET_A, ['0x1f931c1c', '0xcdffacc6']],
    ])
  })

  it('returns an empty array for empty outer brackets', () => {
    expect(parseTroncastFacetsOutput('[]')).toEqual([])
  })

  it('skips an entry whose address is not a 34-character T address', () => {
    const tooShort = FACET_A.slice(0, 33)
    const wrongPrefix = `A${FACET_A.slice(1)}`
    const output = `[[${tooShort} [0x01]] [${wrongPrefix} [0x02]] [${FACET_B} [0x7a0ed627]]]`

    expect(tooShort).toHaveLength(33)
    expect(wrongPrefix).toHaveLength(34)
    expect(parseTroncastFacetsOutput(output)).toEqual([
      [FACET_B, ['0x7a0ed627']],
    ])
  })
})
