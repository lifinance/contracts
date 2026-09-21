/**
 * Which repository a network's deployed code has to be rebuilt from.
 *
 * Tron is proposed, built and deployed out of `lifinance/contracts-tron`
 * (`docs/TronFork.md`), so a Tron record's commit is not on `origin` and the
 * rebuild has to fetch it from the fork. Resolved per network from this repo's
 * own knowledge of where its code lives, never from anything a proposal carries.
 *
 * The remote's URL is checked before it is fetched from, through the same
 * {@link isTrustedRemote} the other gates decide on: `tron` is a name in a local
 * config file, and a name pointed at a proposer's own fork would have the gate
 * rebuild from source they wrote and reach MATCH on it.
 *
 * `origin` is left alone. Asserting its identity here would be a new refusal on
 * every EVM network — a developer whose clone is a personal fork has honest
 * reasons for it — and this module's subject is the one network whose source is
 * somewhere else.
 */

import { isTronNetworkKey } from '@lifi/tron-devkit'

import {
  isTrustedRemote,
  normalizeRepoUrl,
  REPO_CONTRACTS_TRON,
} from '../shared/repo-identity'

/** The remote name the fork is conventionally added under. */
export const TRON_SOURCE_REMOTE = 'tron'

/** The remote every network's source comes from unless it says otherwise. */
export const DEFAULT_SOURCE_REMOTE = 'origin'

export interface ISourceRepository {
  /** The git remote name to read the source through. */
  remote: string
  /** The identity that remote must resolve to, as `normalizeRepoUrl` spells it. */
  repository: string
}

export type SourceRemoteResolution =
  | { ok: true; remote: string }
  | { ok: false; reason: string }

/**
 * The repository a network's code is built in, when it is not this one.
 *
 * @param network - key in `config/networks.json`
 * @returns The fork to read through, or undefined for a network built here
 */
export const sourceRepositoryFor = (
  network: string
): ISourceRepository | undefined =>
  isTronNetworkKey(network)
    ? { remote: TRON_SOURCE_REMOTE, repository: REPO_CONTRACTS_TRON }
    : undefined

/**
 * Names the remote a rebuild may fetch this network's commits from.
 *
 * @param network - key in `config/networks.json`
 * @param deps.git - runs git and returns stdout, throwing on a non-zero exit
 * @returns The remote name, or why no remote here can supply the source
 */
export const resolveSourceRemote = (
  network: string,
  deps: { git: (args: string[]) => string }
): SourceRemoteResolution => {
  const required = sourceRepositoryFor(network)
  if (required === undefined) return { ok: true, remote: DEFAULT_SOURCE_REMOTE }

  let url: string
  try {
    url = deps.git(['remote', 'get-url', required.remote]).trim()
  } catch {
    return {
      ok: false,
      reason: `${network} is built and deployed from ${required.repository}, and this clone has no "${required.remote}" remote, so there is no source to rebuild its code from. Add it and fetch it: git remote add ${required.remote} https://${required.repository}.git && git fetch ${required.remote}`,
    }
  }

  // The identity and never the URL: `normalizeRepoUrl` reduces to
  // `host/owner/repo`, so a remote carrying a token in its userinfo cannot put
  // it in a line a signer reads or a log keeps.
  const identity = normalizeRepoUrl(url)
  if (identity !== required.repository)
    return {
      ok: false,
      reason: `${network} is built and deployed from ${required.repository}, but this clone's "${required.remote}" remote names ${identity}. Rebuilding through it would compare the deployed code against whatever source that remote serves, which is the one thing the comparison may not take on trust. Point it at https://${required.repository}.git.`,
    }

  if (!isTrustedRemote(url, [required.repository]))
    return {
      ok: false,
      reason: `this clone's "${required.remote}" remote names ${required.repository} over a scheme that carries no evidence of what answered. The commit the gate rebuilds ${network}'s code from arrives over it, so it has to be https or ssh. Point it at https://${required.repository}.git.`,
    }

  return { ok: true, remote: required.remote }
}
