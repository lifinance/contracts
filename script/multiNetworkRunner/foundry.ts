import { readFileSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { consola } from 'consola'

import { runShellCommand } from './shell'

export interface IFoundryProfileUpdate {
  solcVersion?: string
  evmVersion?: string
}

export const readFoundryToml = (path: string): string => {
  return readFileSync(path, 'utf8')
}

export const getDefaultEvmVersion = (tomlContents: string): string | null => {
  const lines = tomlContents.split('\n')
  let inDefaultProfile = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      inDefaultProfile = line === '[profile.default]'
      continue
    }
    if (!inDefaultProfile) continue
    const match = line.match(/^evm_version\s*=\s*'([^']+)'/)
    if (match && match[1]) return match[1]
  }
  return null
}

export const updateProfileDefault = (
  tomlContents: string,
  update: IFoundryProfileUpdate
): string => {
  const lines = tomlContents.split('\n')
  const startIndex = lines.findIndex(
    (line) => line.trim() === '[profile.default]'
  )

  if (startIndex === -1) {
    throw new Error('Missing [profile.default] in foundry.toml')
  }

  let endIndex = lines.length
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (lines[i]?.trim().startsWith('[')) {
      endIndex = i
      break
    }
  }

  const updateLine = (key: string, value: string | undefined) => {
    if (!value) return
    let updated = false
    for (let i = startIndex + 1; i < endIndex; i += 1) {
      if (lines[i]?.trim().startsWith(`${key} =`)) {
        lines[i] = `${key} = '${value}'`
        updated = true
        break
      }
    }
    if (!updated) {
      lines.splice(startIndex + 1, 0, `${key} = '${value}'`)
      endIndex += 1
    }
  }

  updateLine('solc_version', update.solcVersion)
  updateLine('evm_version', update.evmVersion)

  return lines.join('\n')
}

export const writeFileAtomic = async (path: string, contents: string) => {
  const tempPath = join(tmpdir(), `foundry-${Date.now()}-${Math.random()}.tmp`)
  writeFileSync(tempPath, contents, 'utf8')
  await rename(tempPath, path)
}

type CommandRunner = typeof runShellCommand

export class FoundryManager {
  private originalContents: string | null = null

  public constructor(
    private readonly path: string,
    private readonly commandRunner: CommandRunner = runShellCommand
  ) {}

  public backup(): void {
    if (this.originalContents) return
    this.originalContents = readFoundryToml(this.path)
  }

  public async restore(): Promise<void> {
    if (!this.originalContents) return
    await writeFileAtomic(this.path, this.originalContents)
    consola.info('Restored foundry.toml')
  }

  public getDefaultEvmVersion(): string | null {
    const contents = this.originalContents ?? readFoundryToml(this.path)
    return getDefaultEvmVersion(contents)
  }

  public async applyLondonProfile(): Promise<void> {
    this.backup()
    if (!this.originalContents) return
    const updated = updateProfileDefault(this.originalContents, {
      solcVersion: '0.8.17',
      evmVersion: 'london',
    })
    await writeFileAtomic(this.path, updated)
    consola.info('Updated foundry.toml for London profile')
    const result = await this.commandRunner('forge clean && forge build')
    if (result.code !== 0)
      throw new Error(`forge build failed with code ${result.code}`)
  }

  public async ensurePrimaryProfile(): Promise<void> {
    this.backup()
    if (!this.originalContents) return
    await writeFileAtomic(this.path, this.originalContents)
  }
}
