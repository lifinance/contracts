import { spawn } from 'node:child_process'

import { consola } from 'consola'

const prefixLine = (prefix: string, line: string): string => {
  const trimmed = line.replace(/\n$/, '')
  if (!trimmed) return ''
  return `${prefix} ${trimmed}`
}

const createLineBuffer = (onLine: (line: string) => void) => {
  let buffer = ''
  return (chunk: Buffer | string) => {
    buffer += chunk.toString()
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index + 1)
      buffer = buffer.slice(index + 1)
      onLine(line)
      index = buffer.indexOf('\n')
    }
  }
}

export interface ICommandResult {
  code: number
}

export const runShellCommand = async (
  command: string,
  options: {
    prefix?: string
    env?: NodeJS.ProcessEnv
    spawnFn?: typeof spawn
  } = {}
): Promise<ICommandResult> => {
  return new Promise((resolve, reject) => {
    const spawnFn = options.spawnFn ?? spawn
    const child = spawnFn('bash', ['-lc', command], {
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const prefix = options.prefix

    if (child.stdout) {
      const onStdout = createLineBuffer((line) => {
        if (prefix) {
          const formatted = prefixLine(prefix, line)
          if (formatted) consola.info(formatted)
        } else {
          process.stdout.write(line)
        }
      })
      child.stdout.on('data', onStdout)
    }

    if (child.stderr) {
      const onStderr = createLineBuffer((line) => {
        if (prefix) {
          const formatted = prefixLine(prefix, line)
          if (formatted) consola.warn(formatted)
        } else {
          process.stderr.write(line)
        }
      })
      child.stderr.on('data', onStderr)
    }

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      resolve({ code: code ?? 1 })
    })
  })
}
