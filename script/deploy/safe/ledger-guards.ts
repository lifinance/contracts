/**
 * Refuses a Ledger run that would propose more than once.
 *
 * `initializeSafeClient` keeps the Ledger account and discards its HID
 * transport, so `closeLedgerConnection` cannot reach it: every proposal in a run
 * opens another transport that is never closed and asks for its own device
 * confirmation. Failing up front beats stalling partway through, which leaves
 * some targets proposed and some not.
 *
 * @param count - How many proposals the chosen mode will create.
 * @param useLedger - Whether the operator asked to sign from hardware.
 * @param what - Named in the error, so the operator knows which flag to split.
 * @throws If a Ledger is selected and more than one proposal would follow.
 */
export const assertLedgerProposesOnce = (
  count: number,
  useLedger: boolean,
  what: string
): void => {
  if (useLedger && count > 1)
    throw new Error(
      `--ledger cannot be combined with ${what} (${count} proposals): each proposal opens its own Ledger connection and asks for its own confirmation. Run them one at a time.`
    )
}
