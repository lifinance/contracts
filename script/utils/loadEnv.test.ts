import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadEnv } from './loadEnv'

const EXPORTED = 'LOADENV_TEST_EXPORTED'
const FILE_ONLY = 'LOADENV_TEST_FILE_ONLY'
const SHELL_SETTINGS = ['DOTENV_OVERRIDE', 'DOTENV_PATH'] as const

describe('loadEnv', () => {
  const saved = new Map<string, string | undefined>()
  let dir = ''

  beforeAll(() => {
    for (const name of [EXPORTED, FILE_ONLY, ...SHELL_SETTINGS])
      saved.set(name, process.env[name])

    dir = mkdtempSync(join(tmpdir(), 'loadenv-'))
    const envFile = join(dir, '.env')
    writeFileSync(envFile, `${EXPORTED}=from-file\n${FILE_ONLY}=from-file\n`)

    process.env[EXPORTED] = 'exported'
    delete process.env[FILE_ONLY]
    process.env.DOTENV_OVERRIDE = 'true'
    process.env.DOTENV_PATH = envFile

    loadEnv()
  })

  afterAll(() => {
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps an exported value even when DOTENV_OVERRIDE is set', () => {
    expect(process.env[EXPORTED]).toBe('exported')
  })

  it('fills in names the shell leaves unset', () => {
    expect(process.env[FILE_ONLY]).toBe('from-file')
  })
})
