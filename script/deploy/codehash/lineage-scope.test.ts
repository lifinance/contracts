/**
 * D19(a): where the codehash gate learns which toolchains a network may
 * legitimately have used.
 *
 * The property under test is not "does it return a boolean" but "can a
 * proposer-controlled value ever widen the legitimate set". `isClosedSet` is
 * derived from repo config only; the deployed bytecode's own trailer is never an
 * input here, because whoever proposes the cut writes it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  deriveToolchainScope,
  parseBuildProfiles,
  ZK_PROFILE,
} from './lineage-scope'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

const networks = JSON.parse(
  readFileSync(join(REPO_ROOT, 'config', 'networks.json'), 'utf8')
) as Record<
  string,
  { targetEvmVersion: string; isZkEVM: boolean; type: string; status: string }
>

const profiles = parseBuildProfiles(
  readFileSync(join(REPO_ROOT, 'foundry.toml'), 'utf8')
)

describe('parseBuildProfiles — read from the real foundry.toml, not a fixture', () => {
  it('finds every profile that pins a compiler pair', () => {
    // Hardcoding these would drift the moment a profile is retuned, which is the
    // failure this whole gate exists to catch one layer down.
    expect(Object.keys(profiles).sort()).toEqual(
      ['default', 'solc_floor', ZK_PROFILE].sort()
    )
  })

  it('reads the zksolc pin, which cannot live in a profile table', () => {
    // vanilla forge warns on an unknown `zksync` key, so the pin sits outside
    // the profile and has to be attached to it deliberately
    expect(profiles[ZK_PROFILE]?.zksolcVersion).toBe('1.5.15')
    expect(profiles.default?.zksolcVersion).toBeUndefined()
  })

  it('pairs each profile with its solc and evm version', () => {
    expect(profiles.default).toMatchObject({
      solcVersion: '0.8.29',
      evmVersion: 'cancun',
    })
    expect(profiles.solc_floor).toMatchObject({
      solcVersion: '0.8.17',
      evmVersion: 'london',
    })
    expect(profiles[ZK_PROFILE]).toMatchObject({
      solcVersion: '0.8.29',
      evmVersion: 'cancun',
    })
  })
})

describe('a renamed zk profile fails loudly instead of leaking', () => {
  // My own comment claimed the pin, not the profile name, is what disqualifies a
  // zksolc profile from a non-zk network — "so renaming the profile cannot
  // re-admit it". That was false: the pin is ATTACHED by name, so a rename drops
  // it and the renamed profile was re-admitted to every cancun network.
  //
  // There is no marker in foundry.toml identifying the zk profile other than its
  // name, so the honest fix is not to key on something else — it is to make the
  // rename a loud failure everywhere rather than a silent widening.
  const renamed = readFileSync(join(REPO_ROOT, 'foundry.toml'), 'utf8').replace(
    '[profile.zksync]',
    '[profile.zkevm]'
  )

  it('refuses to build a profile map that pins zksolc with no zk profile to attach it to', () => {
    expect(() => parseBuildProfiles(renamed)).toThrow(/zksolc/i)
  })

  it('still builds the map when the zk profile is present', () => {
    // The paired positive: without it the rule above could be "always throw".
    expect(
      Object.keys(
        parseBuildProfiles(
          readFileSync(join(REPO_ROOT, 'foundry.toml'), 'utf8')
        )
      ).sort()
    ).toEqual(['default', 'solc_floor', ZK_PROFILE].sort())
  })
})

describe('deriveToolchainScope', () => {
  const scopeOf = (network: string) =>
    deriveToolchainScope(network, { networks, profiles })

  it('closes the set for a cancun mainnet and names the default profile', () => {
    const scope = scopeOf('mainnet')
    expect(scope.isClosedSet).toBe(true)
    expect(scope.profiles.map((p) => p.profile)).toEqual(['default'])
  })

  it('closes the set for a london network via solc_floor', () => {
    const london = Object.keys(networks).find(
      (n) => networks[n]?.targetEvmVersion === 'london'
    )
    expect(london).toBeDefined()
    const scope = scopeOf(london as string)
    expect(scope.isClosedSet).toBe(true)
    expect(scope.profiles.map((p) => p.profile)).toEqual(['solc_floor'])
  })

  it('closes the set for a zkEVM mainnet rather than falling back to open', () => {
    // The trap D19(b) named: "n/a" is not a missing value, it is these chains
    // saying "not an EVM version" because they compile through zksolc. Treating
    // it as unknown would grade every abstract/lens/zksync deploy UNVERIFIABLE —
    // the grey fail-open #2301 was fixed to remove.
    for (const zk of ['abstract', 'lens', 'zksync']) {
      const scope = scopeOf(zk)
      expect(scope.isClosedSet).toBe(true)
      expect(scope.profiles.map((p) => p.profile)).toEqual([ZK_PROFILE])
      expect(scope.profiles[0]?.zksolcVersion).toBe('1.5.15')
    }
  })

  it('refuses a network whose config declares no toolchain at all', () => {
    // localanvil: targetEvmVersion "" and not zkEVM. Refusing beats guessing —
    // it is an inactive testnet and has no production Safe to protect.
    expect(() => scopeOf('localanvil')).toThrow(
      /declares no target EVM version/
    )
  })

  it('refuses an unknown network instead of defaulting', () => {
    expect(() => scopeOf('not-a-network')).toThrow(/not in config\/networks/)
  })

  it('ERRORs when the two config flags contradict each other', () => {
    // Neither direction is safe to guess: isClosedSet=true would false-red an
    // honest deploy, and isClosedSet=false falls back to the proposer-written
    // trailer, reopening the lever D19 closed. So this is a third outcome.
    const contradictory = {
      weird: {
        targetEvmVersion: 'cancun',
        isZkEVM: true,
        type: 'mainnet',
        status: 'active',
      },
    }
    expect(() =>
      deriveToolchainScope('weird', { networks: contradictory, profiles })
    ).toThrow(/contradict/)
  })

  it('ERRORs when the zk profile exists but pins no zksolc', () => {
    // Fails open rather than loudly, which is why it needs its own case: the
    // scope comes back closed, `codehash-sign-gate-deps.ts` reads a missing
    // `zksolcVersion` as "not zk", and zk bytecode is then normalised by EVM
    // rules — a different trailer format and no immutable masking, so the
    // comparison is unsound whichever way it lands. The sibling case (a zksolc
    // pin with no profile to attach it to) is caught in parseBuildProfiles.
    const zkNetwork = {
      abstract: {
        targetEvmVersion: 'n/a',
        isZkEVM: true,
        type: 'mainnet',
        status: 'active',
      },
    }
    const unpinned = {
      ...profiles,
      [ZK_PROFILE]: { ...profiles[ZK_PROFILE], zksolcVersion: undefined },
    }

    expect(() =>
      deriveToolchainScope('abstract', {
        networks: zkNetwork,
        profiles: unpinned as typeof profiles,
      })
    ).toThrow(/pins no zksolc version/)

    // Paired positive: the real profile, which does pin one, still resolves —
    // so the refusal is about the missing pin and not about zk networks.
    expect(
      deriveToolchainScope('abstract', { networks: zkNetwork, profiles })
        .isClosedSet
    ).toBe(true)
  })

  it('refuses an EVM version no profile pins, rather than assuming default', () => {
    // The hole this replaced: a hardcoded version-to-profile table mapped every
    // unrecognised hardfork onto `default`, reporting a CLOSED set against the
    // wrong compiler pair — a false GREEN. No live network hits it today, which
    // is exactly why it needed a test rather than a reading.
    const future = {
      somechain: {
        targetEvmVersion: 'osaka',
        isZkEVM: false,
        type: 'mainnet',
        status: 'active',
      },
    }
    expect(() =>
      deriveToolchainScope('somechain', { networks: future, profiles })
    ).toThrow(/no foundry.toml profile pins/)
  })

  it('never offers a zksolc profile to a non-zk network, even at the same evm version', () => {
    // `zksync` also declares cancun, so matching on evm_version alone put it in
    // scope for every cancun chain — a non-zk network judged against a zksolc
    // build. Keyed on the zksolc pin, not the profile name.
    for (const network of Object.keys(networks)) {
      const row = networks[network]
      if (row?.isZkEVM || row?.targetEvmVersion === 'n/a') continue
      if ((row?.targetEvmVersion ?? '') === '') continue
      const scope = deriveToolchainScope(network, { networks, profiles })
      expect(scope.profiles.every((p) => p.zksolcVersion === undefined)).toBe(
        true
      )
    }
  })

  it('never consults anything the proposer controls', () => {
    // The signature is the guarantee: deps carry repo config only. If a future
    // change threads observed bytecode in here, this fails to compile and this
    // assertion is the note explaining why that is deliberate.
    const scope = scopeOf('mainnet')
    expect(Object.keys(scope).sort()).toEqual(['isClosedSet', 'profiles'])
  })

  describe('the whole real fleet, so a config change cannot quietly open the set', () => {
    const active = Object.keys(networks).filter(
      (n) => networks[n]?.status === 'active'
    )

    it('resolves a closed set for every active network', () => {
      expect(active.length).toBeGreaterThan(60)
      const open: string[] = []
      for (const n of active) {
        const scope = deriveToolchainScope(n, { networks, profiles })
        if (!scope.isClosedSet) open.push(n)
      }
      // An open set here means the trailer becomes the authority for that
      // network, so the honest answer is zero, not "mostly".
      expect(open).toEqual([])
    })
  })
})
