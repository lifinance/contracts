import { readFileSync } from 'fs'
import { DECLARED_STORAGE_AUTHORITIES } from '../script/deploy/safe/prebroadcast-authorities'
const req = JSON.parse(readFileSync('script/deploy/resources/deployRequirements.json','utf8')) as any
for (const [name, auths] of Object.entries(DECLARED_STORAGE_AUTHORITIES)) {
  const owner = (auths as any[]).find(a=>a.getter==='owner')
  const declared = req[name]?.configData?._owner?.keyInConfigFile
  console.log(`${name.padEnd(22)} table=${JSON.stringify(owner?.source)}  req._owner=${declared ?? '(none)'} reqEntry=${req[name]!==undefined}`)
}
console.log('\n--- all deployRequirements entries declaring _owner ---')
for (const [name, v] of Object.entries<any>(req)) {
  const k = v?.configData?._owner?.keyInConfigFile
  if (k) console.log(`${name.padEnd(26)} ${k}  inTable=${DECLARED_STORAGE_AUTHORITIES[name]!==undefined}`)
}
