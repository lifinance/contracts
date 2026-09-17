import {
  createPinnedSourceVersionReader,
  createPinnedTargetStateReader,
  resolveExpectedVersion,
  countNetworksDeclaring,
} from '../script/deploy/safe/pinned-target-state'
const read = createPinnedSourceVersionReader()
import fs from 'node:fs'
const names = fs.readFileSync('/tmp/names.txt', 'utf8').trim().split('\n')
let bad = 0
for (const n of names) {
  const r = read(n)
  if (!r.ok) {
    bad++
    console.log('FAIL', n, r.detail)
  }
}
console.log('total', names.length, 'unresolved', bad)
const st = createPinnedTargetStateReader()()
console.log('pinnedState ok?', st.ok, st.ok ? '' : (st as any).reason)
if (st.ok) {
  console.log('networks', Object.keys(st.state).length)
  // count non-latest values
  const pins: string[] = []
  for (const [net, envs] of Object.entries(st.state as any))
    for (const [env, ds] of Object.entries(envs as any))
      for (const [d, cs] of Object.entries(ds as any))
        for (const [c, v] of Object.entries(cs as any))
          if (v !== 'latest') pins.push(`${net}/${env}/${d}/${c}=${v}`)
  console.log('non-latest entries:', pins.length, pins.slice(0, 10))
  console.log(
    'countNetworksDeclaring(Executor)=',
    countNetworksDeclaring(st.state, 'Executor')
  )
  console.log(
    'resolveExpected mainnet/Executor=',
    JSON.stringify(
      resolveExpectedVersion(st.state, 'mainnet', 'Executor', read)
    )
  )
  console.log(
    'resolveExpected mainnet/Nope=',
    JSON.stringify(
      resolveExpectedVersion(st.state, 'mainnet', 'NopeFacet', read)
    )
  )
}
