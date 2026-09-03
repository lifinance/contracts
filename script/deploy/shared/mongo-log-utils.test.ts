import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { deploymentRecordEqFilter, mongoEq } from './mongo-log-utils'

describe('mongoEq', () => {
  it('wraps a plain value in an equality operator', () => {
    expect(mongoEq('AcrossFacetV4')).toEqual({ $eq: 'AcrossFacetV4' })
    expect(mongoEq(true)).toEqual({ $eq: true })
    expect(mongoEq(200000)).toEqual({ $eq: 200000 })
  })

  /**
   * The Aikido false-positive catalog dismisses NoSQL-injection findings in the
   * deployment-log scripts on the grounds that mongoEq neutralises an operator
   * object, so that property needs a test holding it true.
   */
  it.each([
    ['comparison', { $ne: null }],
    ['evaluation', { $where: 'sleep(1000)' }],
    ['array', { $in: ['a', 'b'] }],
  ])(
    'nests an injected %s operator instead of passing it through',
    (_, payload) => {
      const filter = mongoEq(payload)

      expect(filter).toEqual({ $eq: payload })
      expect(Object.keys(filter)).toEqual(['$eq'])
    }
  )

  it('keeps undefined and null as literal matches', () => {
    expect(mongoEq(undefined)).toEqual({ $eq: undefined })
    expect(mongoEq(null)).toEqual({ $eq: null })
  })
})

describe('deploymentRecordEqFilter', () => {
  it('wraps every supplied field in an equality operator', () => {
    expect(
      deploymentRecordEqFilter({
        contractName: 'AcrossFacetV4',
        network: 'arbitrum',
        verified: false,
      })
    ).toEqual({
      contractName: { $eq: 'AcrossFacetV4' },
      network: { $eq: 'arbitrum' },
      verified: { $eq: false },
    })
  })

  it('omits fields that were not supplied rather than matching on undefined', () => {
    expect(deploymentRecordEqFilter({ network: 'arbitrum' })).toEqual({
      network: { $eq: 'arbitrum' },
    })
    expect(deploymentRecordEqFilter({})).toEqual({})
  })

  /**
   * The filter is a whitelist because its callers hand it caller-supplied
   * objects: a key outside the whitelist must not reach the query at all.
   */
  it('drops keys outside the whitelist', () => {
    const filter = deploymentRecordEqFilter({
      network: 'arbitrum',
      $where: 'sleep(1000)',
      _id: 'deadbeef',
    } as unknown as Parameters<typeof deploymentRecordEqFilter>[0])

    expect(filter).toEqual({ network: { $eq: 'arbitrum' } })
  })
})
