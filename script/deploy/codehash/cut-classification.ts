/**
 * Decides which addresses in a `diamondCut` the codehash gate must vouch for.
 *
 * Classification is **per FacetCut element**, never per operation (adversarial
 * A1): a batch pairing an `Add` with a `Remove` still gates the `Add`, because
 * grading the cut as a whole is how an addition rides in on a deletion.
 *
 * `_init` is treated as a target of its own. It is delegatecalled in the
 * diamond's storage context, so a purely subtractive cut carrying init calldata
 * is arbitrary code framed as a deletion, and is refused rather than gated.
 */

import { getAddress } from 'viem'

/** `LibDiamond.FacetCutActionEnum`. */
export enum FacetCutActionEnum {
  Add = 0,
  Replace = 1,
  Remove = 2,
}

/** Only these point the diamond at code it did not previously run. */
const INSTALLING = new Set<FacetCutActionEnum>([
  FacetCutActionEnum.Add,
  FacetCutActionEnum.Replace,
])

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export interface IFacetCutEntry {
  facetAddress: string
  action: FacetCutActionEnum
}

export interface ICutVerdict {
  /**
   * Checksummed addresses whose code must be vouched for, in first-seen order.
   * Empty when the cut installs nothing.
   */
  gated: string[]
  /**
   * Reasons the cut must not be signed at all, independent of any codehash
   * result. Every one is reported, not just the first.
   */
  refusals: string[]
}

/**
 * Classifies a decoded `diamondCut`.
 *
 * Takes the already-decoded cut rather than calldata on purpose: the gate must
 * judge the same structure the signer is shown, and a second decode is how the
 * bytes vouched for and the bytes signed come apart.
 * @param cut.cuts - the decoded `FacetCut[]`
 * @param cut.init - the cut's `_init` target
 * @returns What to gate, and any reason to refuse outright
 */
export const classifyCut = (cut: {
  cuts: readonly IFacetCutEntry[]
  init: string
}): ICutVerdict => {
  const refusals: string[] = []
  const seen = new Map<string, string>()

  let installs = 0
  for (const [index, entry] of cut.cuts.entries()) {
    if (!Object.values(FacetCutActionEnum).includes(entry.action)) {
      refusals.push(
        `Cut entry ${index} has action ${entry.action}, which is not one of LibDiamond's Add, Replace or Remove. It is not a fourth behaviour to infer — the diamond would revert, and treating it as a removal would exempt it from the codehash check.`
      )
      continue
    }

    if (!INSTALLING.has(entry.action)) continue
    installs += 1

    if (normalise(entry.facetAddress) === ZERO_ADDRESS) {
      refusals.push(
        `Cut entry ${index} installs the zero address, which is what a Remove entry carries. Gating it would produce a clean-looking pass for a cut that installs nothing readable.`
      )
      continue
    }
    remember(seen, entry.facetAddress)
  }

  const initIsSet = normalise(cut.init) !== ZERO_ADDRESS
  if (initIsSet && installs === 0)
    refusals.push(
      `This removal-only cut carries an _init target (${getAddress(
        cut.init
      )}). _init is delegatecalled in the diamond's own storage context, so it runs arbitrary code regardless of the entries describing only removals. A subtractive cut must carry _init == address(0).`
    )
  else if (initIsSet) remember(seen, cut.init)

  return {
    gated: refusals.length > 0 ? [] : [...seen.values()],
    refusals,
  }
}

/**
 * @param value - an address in any case
 */
const normalise = (value: string): string => {
  try {
    return getAddress(value).toLowerCase()
  } catch {
    return value.toLowerCase()
  }
}

/**
 * @param seen - accumulator, keyed lowercase so case cannot duplicate a target
 * @param value - the address to record
 */
const remember = (seen: Map<string, string>, value: string): void => {
  const key = normalise(value)
  if (!seen.has(key)) seen.set(key, getAddress(value))
}
