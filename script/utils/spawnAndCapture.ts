import type { Buffer } from 'buffer'
import { spawn } from 'child_process'

/**
 * Run a command with spawn, capture stdout/stderr, and resolve with stdout on exit 0.
 * Rejects on non-zero exit or spawn error.
 *
 * Use this instead of duplicating spawn + pipe + on('close') logic across scripts.
 *
 * @param executable - Command to run (e.g. 'cast', 'bun')
 * @param args - Arguments (e.g. ['call', address, '...'])
 * @returns Promise that resolves with trimmed stdout, or rejects with an Error
 */
export function spawnAndCapture(
  executable: string,
  args: string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('close', (code: number | null) => {
      if (code !== 0) {
        const error = new Error(
          `Command failed with exit code ${code}: ${stderr || stdout}`
        )
        ;(error as Error & { message: string }).message =
          stderr || stdout || `Exit code ${code}`
        reject(error)
      } else {
        resolve(stdout.trim())
      }
    })

    child.on('error', (error: Error) => {
      reject(error)
    })
  })
}
