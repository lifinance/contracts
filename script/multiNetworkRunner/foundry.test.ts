import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it, mock } from 'bun:test'

import {
  FoundryManager,
  getDefaultEvmVersion,
  readFoundryToml,
  updateProfileDefault,
  writeFileAtomic,
} from './foundry'

describe('foundry', () => {
  it('reads default evm version', () => {
    const contents = "[profile.default]\nevm_version = 'cancun'\n"
    expect(getDefaultEvmVersion(contents)).toBe('cancun')
    expect(getDefaultEvmVersion('[profile.other]')).toBeNull()
  })

  it('updates profile.default fields', () => {
    const contents =
      "[profile.default]\nsolc_version = '0.8.29'\nevm_version = 'cancun'\n"
    const updated = updateProfileDefault(contents, {
      solcVersion: '0.8.17',
      evmVersion: 'london',
    })

    expect(updated).toContain("solc_version = '0.8.17'")
    expect(updated).toContain("evm_version = 'london'")
  })

  it('inserts missing entries and throws without default profile', () => {
    const contents = "[profile.default]\nsolc_version = '0.8.29'\n"
    const updated = updateProfileDefault(contents, { evmVersion: 'london' })
    expect(updated).toContain("evm_version = 'london'")

    expect(() =>
      updateProfileDefault('[profile.other]', { evmVersion: 'london' })
    ).toThrow('Missing [profile.default] in foundry.toml')
  })

  it('writes file atomically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foundry-test-'))
    const filePath = join(dir, 'foundry.toml')
    writeFileSync(filePath, 'initial', 'utf8')

    await writeFileAtomic(filePath, 'updated')
    const updated = readFileSync(filePath, 'utf8')
    expect(updated).toBe('updated')
    expect(readFoundryToml(filePath)).toBe('updated')

    rmSync(dir, { recursive: true, force: true })
  })

  it('applies london profile and restores original', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foundry-test-'))
    const filePath = join(dir, 'foundry.toml')
    const original =
      "[profile.default]\nsolc_version = '0.8.29'\nevm_version = 'cancun'\n"
    writeFileSync(filePath, original, 'utf8')

    const runner = mock(async () => ({ code: 0 }))
    const manager = new FoundryManager(filePath, runner)
    manager.backup()

    await manager.applyLondonProfile()
    const updated = readFileSync(filePath, 'utf8')
    expect(updated).toContain("solc_version = '0.8.17'")
    expect(updated).toContain("evm_version = 'london'")
    expect(runner).toHaveBeenCalled()

    await manager.restore()
    const restored = readFileSync(filePath, 'utf8')
    expect(restored).toBe(original)

    rmSync(dir, { recursive: true, force: true })
  })

  it('throws when forge build fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foundry-test-'))
    const filePath = join(dir, 'foundry.toml')
    const original =
      "[profile.default]\nsolc_version = '0.8.29'\nevm_version = 'cancun'\n"
    writeFileSync(filePath, original, 'utf8')

    const runner = mock(async () => ({ code: 1 }))
    const manager = new FoundryManager(filePath, runner)
    manager.backup()

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(manager.applyLondonProfile()).rejects.toThrow(
      'forge build failed'
    )

    rmSync(dir, { recursive: true, force: true })
  })

  it('reapplies primary profile when requested', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foundry-test-'))
    const filePath = join(dir, 'foundry.toml')
    const original =
      "[profile.default]\nsolc_version = '0.8.29'\nevm_version = 'cancun'\n"
    writeFileSync(filePath, original, 'utf8')

    const runner = mock(async () => ({ code: 0 }))
    const manager = new FoundryManager(filePath, runner)
    manager.backup()

    writeFileSync(filePath, 'modified', 'utf8')
    await manager.ensurePrimaryProfile()

    const restored = readFileSync(filePath, 'utf8')
    expect(restored).toBe(original)

    rmSync(dir, { recursive: true, force: true })
  })
})
