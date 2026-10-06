/**
 * Builds the action prompt `confirm-safe-tx.ts` puts in front of a signer for
 * one proposal. Pure, so which options a refused proposal is offered can be
 * tested without driving the CLI.
 */

export interface ISignerActionMenuInput {
  /**
   * True when the proposal must not be signed or executed from this prompt: a
   * delegatecall, or a definite red from gate G, I, J or L.
   */
  refused: boolean
  /** The signer's key holds the Safe-signer role rather than a Ledger/owner key. */
  safeSigner: boolean
  hasSignedAlready: boolean
  /** The current signature set plus this signer's would meet the threshold. */
  wouldMeetThreshold: boolean
  /** Signing with this signer and then the deployer would meet the threshold. */
  showSignAndExecuteWithDeployer: boolean
  /** The proposal already carries enough signatures to be broadcast. */
  executable: boolean
}

export const DO_NOTHING = 'Do Nothing'

/**
 * Every option the prompt can offer, in prompt order. `confirm-safe-tx.ts`
 * dispatches each one other than `DO_NOTHING` through `createSigningFunnels`.
 */
export const SIGNER_ACTIONS = [
  DO_NOTHING,
  'Sign',
  'Sign & Execute',
  'Sign and Execute With Deployer',
  'Execute',
  'Execute with Deployer',
] as const

export type TSignerAction = (typeof SIGNER_ACTIONS)[number]

const OFFERED: Record<
  TSignerAction,
  (input: ISignerActionMenuInput) => boolean
> = {
  [DO_NOTHING]: () => true,
  Sign: (input) => !input.hasSignedAlready,
  'Sign & Execute': (input) =>
    !input.hasSignedAlready && !input.safeSigner && input.wouldMeetThreshold,
  'Sign and Execute With Deployer': (input) =>
    !input.hasSignedAlready && input.showSignAndExecuteWithDeployer,
  Execute: (input) => input.executable,
  'Execute with Deployer': (input) => input.executable,
}

/**
 * The options, `Do Nothing` first.
 *
 * A refused proposal is offered `Do Nothing` alone: every other option ends in
 * a signature or a broadcast.
 *
 * @param input - What this proposal and this signer allow.
 * @returns The option strings in prompt order.
 */
export const buildSignerActionOptions = (
  input: ISignerActionMenuInput
): string[] => {
  if (input.refused) return [DO_NOTHING]
  return SIGNER_ACTIONS.filter((action) => OFFERED[action](input))
}
