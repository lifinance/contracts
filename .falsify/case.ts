import { encodeFunctionData, getAddress, type Hex, type Address } from 'viem'
import { DIAMOND_CUT_ABI } from '../script/deploy/shared/constants'
import { TIMELOCK_SCHEDULE_ABI } from '../script/deploy/safe/timelock-abi'
import { collectDiamondCutCalls } from '../script/deploy/shared/diamond-cut-calls'
const DIAMOND = getAddress('0xd1a4000000000000000000000000000000000002')
const TIMELOCK = getAddress('0x71e10c1000000000000000000000000000000001')
const SAFE = getAddress('0x5afe00000000000000000000000000000000face')
const FACET = getAddress('0xface000000000000000000000000000000000004')
const ZERO = '0x0000000000000000000000000000000000000000' as Address
for (const sel of ['0xAABBCCDD', '0xaabbccdd'] as Hex[]) {
  const inner = encodeFunctionData({ abi: DIAMOND_CUT_ABI, functionName: 'diamondCut',
    args: [[{ facetAddress: FACET, action: 0, functionSelectors: [sel] }], ZERO, '0x'] })
  const outer = encodeFunctionData({ abi: TIMELOCK_SCHEDULE_ABI, functionName: 'schedule',
    args: [DIAMOND, 0n, inner, ('0x'+'00'.repeat(32)) as Hex, ('0x'+'11'.repeat(32)) as Hex, 86400n] })
  const { calls } = collectDiamondCutCalls([outer], { targets: [TIMELOCK], caller: SAFE })
  const raw = calls[0]!.raw
  console.log(`sel=${sel}  exact:`, raw === inner, ' lowercased:', raw.toLowerCase() === inner.toLowerCase(), ' len:', raw.length, inner.length)
  if (raw !== inner) console.log('   inner:', inner.slice(0, 20), '...\n   raw  :', raw.slice(0, 20), '...')
}
