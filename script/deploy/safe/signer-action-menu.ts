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
  const options = ['Do Nothing']
  if (input.refused) return options

  if (!input.hasSignedAlready) {
    options.push('Sign')
    if (!input.safeSigner && input.wouldMeetThreshold)
      options.push('Sign & Execute')
    if (input.showSignAndExecuteWithDeployer)
      options.push('Sign and Execute With Deployer')
  }

  if (input.executable) {
    options.push('Execute')
    options.push('Execute with Deployer')
  }

  return options
}
