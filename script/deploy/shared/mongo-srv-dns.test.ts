import dns from 'node:dns'

import {
  describe,
  expect,
  it,
  afterEach,
  // eslint-disable-next-line import/no-unresolved, import/order
} from 'bun:test'

import {
  withSrvDnsFallback,
  resetSrvDnsFallbackForTests,
} from './mongo-srv-dns'

function makeSrvError(code = 'EBADRESP'): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `querySrv ${code} _mongodb._tcp.cluster.example.mongodb.net`
  )
  error.syscall = 'querySrv'
  error.code = code
  return error
}

describe('withSrvDnsFallback', () => {
  const originalServers = dns.getServers()
  const originalEnv = process.env.MONGODB_DNS_SERVERS

  afterEach(() => {
    dns.setServers(originalServers)
    resetSrvDnsFallbackForTests()
    if (originalEnv === undefined) delete process.env.MONGODB_DNS_SERVERS
    else process.env.MONGODB_DNS_SERVERS = originalEnv
  })

  it('returns the result without touching DNS servers when connect succeeds', async () => {
    const before = dns.getServers()

    const result = await withSrvDnsFallback(async () => 'connected')

    expect(result).toBe('connected')
    expect(dns.getServers()).toEqual(before)
  })

  it('retries with fallback DNS servers after an SRV lookup failure', async () => {
    process.env.MONGODB_DNS_SERVERS = '1.1.1.1,8.8.8.8'
    let attempts = 0

    const result = await withSrvDnsFallback(async () => {
      attempts++
      if (attempts === 1) throw makeSrvError()
      return 'connected'
    })

    expect(result).toBe('connected')
    expect(attempts).toBe(2)
    expect(dns.getServers()).toEqual(['1.1.1.1', '8.8.8.8'])
  })

  it('rethrows errors that are not SRV lookup failures', async () => {
    const before = dns.getServers()

    // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is thenable at runtime
    await expect(
      withSrvDnsFallback(async () => {
        throw new Error('Authentication failed.')
      })
    ).rejects.toThrow('Authentication failed.')

    expect(dns.getServers()).toEqual(before)
  })

  it('rethrows when the retry also fails', async () => {
    process.env.MONGODB_DNS_SERVERS = '1.1.1.1'
    let attempts = 0

    // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is thenable at runtime
    await expect(
      withSrvDnsFallback(async () => {
        attempts++
        throw makeSrvError()
      })
    ).rejects.toThrow('querySrv EBADRESP')

    expect(attempts).toBe(2)
  })

  it('does not retry a second time once the fallback is already applied', async () => {
    process.env.MONGODB_DNS_SERVERS = '1.1.1.1'
    await withSrvDnsFallback(async () => 'warm-up')

    let firstCallAttempts = 0
    await withSrvDnsFallback(async () => {
      firstCallAttempts++
      if (firstCallAttempts === 1) throw makeSrvError()
      return 'connected'
    })

    let secondCallAttempts = 0
    // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is thenable at runtime
    await expect(
      withSrvDnsFallback(async () => {
        secondCallAttempts++
        throw makeSrvError()
      })
    ).rejects.toThrow('querySrv EBADRESP')

    expect(secondCallAttempts).toBe(1)
  })

  it('rethrows the original error when the configured server list is empty', async () => {
    process.env.MONGODB_DNS_SERVERS = ' , '
    let attempts = 0

    // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is thenable at runtime
    await expect(
      withSrvDnsFallback(async () => {
        attempts++
        throw makeSrvError()
      })
    ).rejects.toThrow('querySrv EBADRESP')

    expect(attempts).toBe(1)
  })
})
