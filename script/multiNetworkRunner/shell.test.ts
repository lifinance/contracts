import { EventEmitter } from 'node:events'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { runShellCommand } from './shell'

describe('shell', () => {
  it('returns success code for successful command', async () => {
    const result = await runShellCommand('echo "hello"')
    expect(result.code).toBe(0)
  })

  it('returns non-zero code for failing command', async () => {
    const result = await runShellCommand('exit 3')
    expect(result.code).toBe(3)
  })

  it('prefixes stdout and stderr when prefix is provided', async () => {
    const result = await runShellCommand('echo "out" && echo "err" 1>&2', {
      prefix: '[test]',
    })
    expect(result.code).toBe(0)
  })

  it('rejects when spawn emits error', async () => {
    const spawnFn = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const child = new EventEmitter() as any
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      setTimeout(() => {
        child.emit('error', new Error('spawn failed'))
      }, 0)
      return child
    }

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runShellCommand('echo "noop"', { spawnFn: spawnFn as any })
    ).rejects.toThrow('spawn failed')
  })
})
