/**
 * Derives which toolchains a network's deployed code may legitimately have been
 * built with, for {@link compareToAttestedSet}'s `scope`.
 *
 * Every input is repo configuration. The deployed bytecode's metadata trailer
 * reports its own compiler version and is written by whoever proposes the cut,
 * so consulting it here would let a proposer widen the set they are checked
 * against — measured on a real facet: one code byte flipped plus three trailer
 * bytes claiming solc 0.8.99 moved the verdict from MISMATCH to UNVERIFIABLE.
 */

/** The `foundry.toml` profile zkEVM networks build under. */
export const ZK_PROFILE = 'zksync'

/** A compiler pair `foundry.toml` pins, and CI therefore builds. */
export interface IBuildProfile {
  profile: string
  solcVersion: string
  evmVersion: string
  /**
   * Only the zk profile has one. It cannot live inside the profile table —
   * vanilla forge warns on an unknown `zksync` key — so it is read separately
   * and attached here.
   */
  zksolcVersion?: string
}

/** Minimum of `config/networks.json` this needs; the real rows carry far more. */
interface INetworkToolchainRow {
  targetEvmVersion: string
  isZkEVM: boolean
}

export interface IToolchainScope {
  /**
   * True when `profiles` enumerates every toolchain this network's code can
   * legitimately have been built with, so code matching none of them is not a
   * build.
   */
  isClosedSet: boolean
  /** The legitimate pairs, in the order they should be tried. */
  profiles: IBuildProfile[]
}

const PROFILE_HEADER = /^\s*\[profile\.([A-Za-z0-9_]+)\]\s*$/
const ANY_SECTION = /^\s*\[[^\]]+\]\s*$/
const SOLC = /^\s*solc_version\s*=\s*['"]([^'"]+)['"]/
const EVM = /^\s*evm_version\s*=\s*['"]([^'"]+)['"]/
const ZKSOLC = /^\s*zksolc\s*=\s*['"]([^'"]+)['"]/

/**
 * Reads the compiler pairs out of `foundry.toml`.
 *
 * Parsed rather than hardcoded: a hardcoded pair would keep passing after
 * someone retunes a profile, which is the same silent-drift failure the gate
 * downstream exists to catch. Only profiles pinning BOTH versions are returned —
 * a profile that pins neither (`ci`, the `fuzz` sub-tables) is not a lineage.
 * @param toml - contents of `foundry.toml`
 */
export const parseBuildProfiles = (
  toml: string
): Record<string, IBuildProfile> => {
  const found: Record<string, IBuildProfile> = {}
  let current: string | undefined
  let zksolcVersion: string | undefined
  const partial: Record<string, { solc?: string; evm?: string }> = {}

  for (const line of toml.split('\n')) {
    const header = PROFILE_HEADER.exec(line)
    if (header) {
      current = header[1]
      partial[current as string] ??= {}
      continue
    }
    // A `[profile.x.fuzz]` or any other table ends the profile's own body, so
    // keys below it must not be attributed to the profile above.
    if (ANY_SECTION.test(line)) {
      current = undefined
      continue
    }

    const zk = ZKSOLC.exec(line)
    if (zk) zksolcVersion = zk[1]

    if (current === undefined) continue
    const solc = SOLC.exec(line)
    if (solc) (partial[current] as { solc?: string }).solc = solc[1]
    const evm = EVM.exec(line)
    if (evm) (partial[current] as { evm?: string }).evm = evm[1]
  }

  for (const [profile, pair] of Object.entries(partial)) {
    if (pair.solc === undefined || pair.evm === undefined) continue
    found[profile] = {
      profile,
      solcVersion: pair.solc,
      evmVersion: pair.evm,
      ...(profile === ZK_PROFILE && zksolcVersion !== undefined
        ? { zksolcVersion }
        : {}),
    }
  }

  // The zksolc pin sits outside every profile table, because vanilla forge warns
  // on an unknown `zksync` key — so attaching it to a profile can only be done
  // by name, and nothing else in the file identifies the zk profile.
  //
  // That makes a rename dangerous rather than merely inconvenient: the pin
  // silently detaches, the renamed profile then looks like a plain cancun
  // lineage, and it is admitted to every non-zk cancun network while the zk
  // networks lose theirs. Refusing here turns that into one loud failure
  // wherever the map is built, instead of a quiet widening in one direction and
  // a quiet break in the other.
  if (zksolcVersion !== undefined && found[ZK_PROFILE] === undefined)
    throw new Error(
      `foundry.toml pins zksolc ${zksolcVersion} but has no "[profile.${ZK_PROFILE}]" to attach it to. The pin can only be attached by name, so a renamed zk profile would detach it — the renamed profile would then be offered to non-zk networks as an ordinary lineage, and zkEVM networks would have none. Rename it back, or update ZK_PROFILE in lineage-scope.ts to match.`
    )

  return found
}

/**
 * Resolves a network to the toolchains it may legitimately have used.
 * @param network - key in `config/networks.json`
 * @param deps.networks - the parsed network config
 * @param deps.profiles - the parsed `foundry.toml` profiles
 * @throws If the network is unknown, declares no toolchain, its two config
 * flags disagree, or the profile its config names is not pinned
 */
export const deriveToolchainScope = (
  network: string,
  deps: {
    networks: Record<string, INetworkToolchainRow>
    profiles: Record<string, IBuildProfile>
  }
): IToolchainScope => {
  const row = deps.networks[network]
  if (row === undefined)
    throw new Error(
      `Toolchain scope: "${network}" is not in config/networks.json, so the set of legitimate builds cannot be established. Add it, or pass a network that exists — do not fall back to reading the deployed trailer.`
    )

  const declaresZk = row.targetEvmVersion.toLowerCase() === 'n/a'
  if (declaresZk !== row.isZkEVM)
    throw new Error(
      `Toolchain scope: config/networks.json entries for "${network}" contradict each other — targetEvmVersion is "${row.targetEvmVersion}" while isZkEVM is ${row.isZkEVM}. Neither reading is safe to assume: treating the set as closed would refuse an honest deploy, and treating it as open falls back to the compiler version the deployed bytecode reports about itself, which the proposer writes. Fix the config.`
    )

  // zkEVM chains compile through zksolc, so "n/a" is a positive statement that
  // no EVM hardfork applies — not an absent value to fall back on.
  if (declaresZk) {
    const zk = deps.profiles[ZK_PROFILE]
    if (zk === undefined)
      throw new Error(
        `Toolchain scope: "${network}" is zkEVM, but foundry.toml pins no "${ZK_PROFILE}" profile. Either it was renamed or the network's config is stale.`
      )
    // A profile that exists without a zksolc pin is the more dangerous shape of
    // the same problem, and it fails open rather than loudly: the scope comes
    // back closed, `codehash-sign-gate-deps.ts` reads `zksolcVersion === undefined`
    // as "not zk", and zkEVM code is then normalised by EVM rules — a different
    // trailer format and no immutable masking, so the comparison is unsound in
    // whichever direction it lands.
    if (zk.zksolcVersion === undefined)
      throw new Error(
        `Toolchain scope: "${network}" is zkEVM and foundry.toml has a "${ZK_PROFILE}" profile, but that profile pins no zksolc version. Nothing then says which compiler its code should have been built with, and treating it as an EVM lineage would compare zk bytecode under EVM normalisation.`
      )
    return { isClosedSet: true, profiles: [zk] }
  }

  const version = row.targetEvmVersion.trim().toLowerCase()
  if (version === '')
    throw new Error(
      `Toolchain scope: "${network}" declares no target EVM version and is not marked zkEVM, so nothing says which compiler its code should have been built with.`
    )

  // Matched against what the profiles actually declare rather than a hardcoded
  // version-to-profile table: a table would map an unrecognised hardfork onto
  // `default` and report a closed set against the wrong compiler pair, which is
  // a false GREEN. No profile declaring the version is the honest failure.
  //
  // A zksolc pin disqualifies a profile here however its evm_version reads: the
  // zk profile also declares cancun, and a non-zk network compiled by solc must
  // never be judged against a zksolc build.
  //
  // The pin is what is tested, but it is ATTACHED by name in parseBuildProfiles,
  // so this filter alone does not survive a rename — a renamed profile carries
  // no pin and would pass. `parseBuildProfiles` refuses to build such a map at
  // all, which is what actually closes that path.
  const matching = Object.values(deps.profiles)
    .filter(
      (p) =>
        p.zksolcVersion === undefined && p.evmVersion.toLowerCase() === version
    )
    .sort((a, b) => a.profile.localeCompare(b.profile))
  if (matching.length === 0)
    throw new Error(
      `Toolchain scope: "${network}" declares EVM version "${row.targetEvmVersion}", which no foundry.toml profile pins — so there is no attested build to compare against and the legitimate set cannot be enumerated. Add a profile for it, or correct the network's config.`
    )

  return { isClosedSet: true, profiles: matching }
}
