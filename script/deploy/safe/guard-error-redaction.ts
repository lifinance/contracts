/**
 * Redaction for the errors a pre-execute guard catches.
 *
 * The guards in `execute-pending-timelock-tx.ts` catch viem and Mongo-driver
 * errors, and both embed a credentialed endpoint in `error.message`. The job
 * log masks only what the workflow declared as a secret, and the Slack webhook
 * sits outside the mask entirely, so neither sink may be handed the error.
 */

import { redactErrorReason, redactUrls } from '../../utils/redactUrls'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Detail for the job log: redacted, but neither collapsed nor capped, so the
 * stack a human debugs from survives.
 *
 * @param error - The caught value.
 * @returns Printable text with every `scheme://…` token replaced.
 */
export const guardErrorDetail = (error: unknown): string =>
  redactUrls(
    error instanceof Error ? error.stack ?? error.message : String(error)
  )

/**
 * The same error, made publishable.
 *
 * Returns an `Error` rather than a string because the notifier reads `.message`
 * off whatever it is given and renders it into the Slack block unredacted; a
 * plain string would take a different branch of that reader.
 *
 * @param error - The caught value.
 * @returns An `Error` whose message is redacted, single-line and length-capped.
 */
export const publishableGuardError = (error: unknown): Error =>
  new Error(redactErrorReason(messageOf(error)))
