/**
 * Derives the constructor args a deployment of `<contract>@<version>` should
 * have been given, from this repo's own deploy-requirements registry and
 * `config/` — the side a proposer does not control.
 *
 * Import this before `verifyByConstructorReplay`. Nothing here reads a chain,
 * an explorer or a block; the module takes no client and its only inputs are a
 * build artifact's constructor ABI, the registry, and `config/`. That is the
 * whole security content: `forge verify-bytecode` sources the same args from
 * the explorer record or from the tail of the onchain creation code, so every
 * immutable it checks verifies against itself.
 *
 * The deployment record's own `constructorArgs` field is a cross-check, never a
 * source. It is ours, but it was written by the deploy that is under
 * examination, so a disagreement with `config/` means one of the two is wrong
 * and neither can decide — that refuses.
 */
import { encodeAbiParameters } from 'viem'

import type { IDeployRequirementEntry } from '../shared/immutableBindings'
import {
  loadConfigFileFromDisk,
  resolveExpectedAddress,
  substituteConfigKeyPlaceholders,
} from '../shared/immutableBindings'

import { strip0x } from './hex'

/** One entry of a build artifact's constructor ABI, in declaration order. */
export interface IConstructorInput {
  name: string
  type: string
}

/** One constructor arg whose expected value `config/` answered. */
export interface IResolvedArg {
  name: string
  type: string
  /** The value as written in config, checksummed or not. */
  value: string
  /** `config/<file>` plus the key that answered, for a line a human reads. */
  origin: string
}

export interface IDerivedArgs {
  ok: true
  args: IResolvedArg[]
  /** ABI-encoded tail, lowercase and without `0x`. Empty for a nullary constructor. */
  encoded: string
}

export interface IArgsUndrivable {
  ok: false
  reason: string
}

export type ExpectedArgs = IDerivedArgs | IArgsUndrivable

export interface IExpectedArgsRequest {
  contractName: string
  /** Constructor ABI inputs in declaration order, from our own build artifact. */
  inputs: readonly IConstructorInput[]
  network: string
  environment: string
  /**
   * `constructorArgs` as our deployment record holds it. Cross-checked against
   * the config-derived encoding; absent on a record that carries none.
   */
  recordedArgs?: string
}

/**
 * The only arg type a config value can be replayed as. A Tron binding resolves
 * to base58 and a numeric or bytes arg has no registry annotation to resolve
 * from, so both refuse rather than guess an encoding.
 */
const SUPPORTED_TYPE = 'address'

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

const undrivable = (reason: string): IArgsUndrivable => ({ ok: false, reason })

/**
 * Whether the deployment record's own `constructorArgs` contradict the encoding
 * derived from config. A record carrying none is not a contradiction — most
 * records predate the field — so only a present, differing value counts.
 *
 * Shared with the nullary path deliberately: a constructor that takes nothing
 * still has an expected encoding, the empty one, and a record claiming
 * arguments against it is the same disagreement between two repo-controlled
 * sources that this refuses everywhere else.
 */
const recordDisagrees = (
  recorded: string | undefined,
  encoded: string
): boolean =>
  recorded !== undefined &&
  recorded !== '' &&
  strip0x(recorded).toLowerCase() !== encoded

/**
 * Resolves every constructor arg of a contract to the value `config/` declares.
 *
 * Fails closed on the first arg it cannot answer. There is deliberately no
 * partial result: a replay run with some args guessed produces runtime code
 * that differs from the deployed code for reasons that have nothing to do with
 * the deployment, and a caller cannot tell those two apart.
 *
 * @param request - Contract, its constructor ABI, and the network to resolve for.
 * @param requirements - `deployRequirements.json`, injectable for tests.
 * @param loadConfigFile - Config loader, injectable for tests.
 * @returns The resolved args and their ABI encoding, or why they cannot be derived.
 */
export const deriveExpectedConstructorArgs = (
  request: IExpectedArgsRequest,
  requirements: Record<string, IDeployRequirementEntry>,
  loadConfigFile: (fileName: string) => unknown = loadConfigFileFromDisk
): ExpectedArgs => {
  const { contractName, inputs, network, environment } = request

  if (inputs.length === 0)
    return recordDisagrees(request.recordedArgs, '')
      ? undrivable(
          `${contractName}'s constructor takes no arguments but the deployment record for ${network} carries constructorArgs, so the record does not describe this build`
        )
      : { ok: true, args: [], encoded: '' }

  const configData = requirements[contractName]?.configData
  if (!configData)
    return undrivable(
      `${contractName} has no configData in the deploy-requirements registry, so its ${inputs.length} constructor args cannot be derived from config`
    )

  const args: IResolvedArg[] = []
  for (const input of inputs) {
    if (input.type !== SUPPORTED_TYPE)
      return undrivable(
        `${contractName} constructor arg ${input.name} is ${input.type}, and only ${SUPPORTED_TYPE} args have a config-side expectation`
      )

    const entry = Object.prototype.hasOwnProperty.call(configData, input.name)
      ? configData[input.name]
      : undefined
    if (!entry)
      return undrivable(
        `${contractName} constructor arg ${input.name} is not annotated in the deploy-requirements registry, so config declares no expected value for it`
      )

    const { keyUsed, expectedAddress } = resolveExpectedAddress(
      loadConfigFile(entry.configFileName),
      entry.keyInConfigFile,
      network,
      environment
    )
    const readableKey = substituteConfigKeyPlaceholders(
      keyUsed,
      network,
      environment
    )

    if (expectedAddress === null)
      return undrivable(
        `config/${entry.configFileName} has no value at ${readableKey} for ${network}, so ${contractName} constructor arg ${input.name} has no expected value`
      )
    if (!EVM_ADDRESS.test(expectedAddress))
      return undrivable(
        `config/${entry.configFileName} answers ${readableKey} for ${network} with a value that is not a 20-byte hex address, so ${contractName} constructor arg ${input.name} cannot be encoded`
      )

    args.push({
      name: input.name,
      type: input.type,
      value: expectedAddress,
      origin: `config/${entry.configFileName}${readableKey}`,
    })
  }

  let encoded: string
  try {
    encoded = strip0x(
      encodeAbiParameters(
        args.map((arg) => ({ name: arg.name, type: arg.type })),
        args.map((arg) => arg.value)
      )
    ).toLowerCase()
  } catch (error) {
    return undrivable(
      `${contractName} constructor args resolved from config but did not encode: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  if (recordDisagrees(request.recordedArgs, encoded))
    return undrivable(
      `the deployment record's constructorArgs disagree with what config declares for ${contractName} on ${network}, so neither can be treated as the expectation`
    )

  return { ok: true, args, encoded }
}
