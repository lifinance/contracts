/**
 * One-shot trigger for the Hexagate end-to-end emergency-pause test.
 *
 * Fires the on-chain event the Hexagate test monitor `"TEST DIAMOND STAGING
 * EMERGENCY PAUSING USING PeripheryContractRegistered contract event"` watches
 * for: a `PeripheryContractRegistered` log on the BSC **staging** diamond.
 * Hexagate then dispatches the production `diamondEmergencyPause.yml`
 * workflow via the lifi-hexagate-pauser PAT.
 *
 * Use when executing the production emergency-pause test plan (Notion: "How to
 * test the production Diamond emergency pause workflow end-to-end via
 * Hexagate", section 4 / checklist step D2, and again for section 9 / step H).
 * Both Track A (fake `PRIV_KEY_PAUSER_WALLET`) and Track B (real key) use the
 * same on-chain trigger; this script is environment-agnostic about that.
 *
 * Run: `bunx tsx ./script/tasks/temp/triggerHexagateTestEvent.ts`
 *      `bunx tsx ./script/tasks/temp/triggerHexagateTestEvent.ts --name MyTag`
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import 'dotenv/config'
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { EnvironmentEnum, type SupportedChain } from '../../common/types'
import { getEnvVar } from '../../utils/utils'
import {
  buildExplorerTxUrl,
  getContractAddressForNetwork,
  getViemChainForNetworkName,
  networks,
} from '../../utils/viemScriptHelpers'

const PERIPHERY_REGISTRY_ABI = parseAbi([
  'function registerPeripheryContract(string _name, address _contractAddress) external',
  'function getPeripheryContract(string _name) view returns (address)',
  'function owner() view returns (address)',
])

// Sentinel address registered under the test name. The registry only stores
// the mapping; nothing on-chain ever calls into this address, so EOA/contract
// distinction does not matter.
const DEFAULT_PERIPHERY_ADDRESS: Address =
  '0x000000000000000000000000000000000000dEaD'

// Topic[0] of PeripheryContractRegistered(string,address) — the value Hexagate's
// monitor matches against. Computed at runtime so the keccak source string
// stays the source of truth (no hard-coded hash drift).
const PERIPHERY_REGISTERED_TOPIC = keccak256(
  toBytes('PeripheryContractRegistered(string,address)')
)

const main = defineCommand({
  meta: {
    name: 'triggerHexagateTestEvent',
    description:
      'Emit PeripheryContractRegistered on the BSC staging diamond to fire the Hexagate production-pause test monitor.',
  },
  args: {
    network: {
      type: 'string',
      description:
        'Network key from config/networks.json. Default: bsc (the Hexagate test monitor watches BSC).',
    },
    environment: {
      type: 'string',
      description:
        'Diamond environment: staging (default) or production. The Hexagate test monitor watches the STAGING diamond.',
    },
    name: {
      type: 'string',
      description:
        'Periphery registry name to write. Default: HexagateTest-<unix-ts>.',
    },
    address: {
      type: 'string',
      description: `Address to register under the name. Default: ${DEFAULT_PERIPHERY_ADDRESS}.`,
    },
  },
  async run({ args }) {
    const networkName = args.network ?? 'bsc'
    if (!(networkName in networks)) {
      consola.error(
        `Network '${networkName}' not found in config/networks.json.`
      )
      process.exit(1)
    }

    const environment =
      args.environment === 'production'
        ? EnvironmentEnum.production
        : EnvironmentEnum.staging
    if (environment === EnvironmentEnum.production)
      consola.warn(
        'Targeting the PRODUCTION diamond. The Hexagate test monitor watches STAGING — this is almost certainly not what you want.'
      )

    const peripheryName =
      args.name ?? `HexagateTest-${Math.floor(Date.now() / 1000)}`
    const peripheryAddress = getAddress(
      args.address ?? DEFAULT_PERIPHERY_ADDRESS
    )

    const diamondAddress = getAddress(
      await getContractAddressForNetwork(
        'LiFiDiamond',
        networkName as SupportedChain,
        environment
      )
    )

    // Staging diamond is owned by devWallet (PRIVATE_KEY); production by the
    // production deployer key. Matches `getPrivateKey()` in helperFunctions.sh.
    const pkVar =
      environment === EnvironmentEnum.production
        ? 'PRIVATE_KEY_PRODUCTION'
        : 'PRIVATE_KEY'
    const rawPk = getEnvVar(pkVar)
    const account = privateKeyToAccount(
      (rawPk.startsWith('0x') ? rawPk : `0x${rawPk}`) as `0x${string}`
    )

    const chain = getViemChainForNetworkName(networkName)
    const publicClient = createPublicClient({ chain, transport: http() })
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(),
    })

    consola.info(`Network        : ${networkName}`)
    consola.info(`Environment    : ${environment}`)
    consola.info(`Diamond        : ${diamondAddress}`)
    consola.info(`Signer         : ${account.address}`)
    consola.info(`Periphery name : ${peripheryName}`)
    consola.info(`Periphery addr : ${peripheryAddress}`)

    // Owner check up-front so we fail before broadcasting if the wrong key is
    // loaded; LibDiamond.enforceIsContractOwner() would revert otherwise.
    const owner = await publicClient.readContract({
      address: diamondAddress,
      abi: PERIPHERY_REGISTRY_ABI,
      functionName: 'owner',
    })
    if (getAddress(owner) !== getAddress(account.address)) {
      consola.error(
        `Signer ${account.address} is not the diamond owner (${owner}). registerPeripheryContract would revert.`
      )
      process.exit(1)
    }

    const balance = await publicClient.getBalance({ address: account.address })
    if (balance === 0n) {
      consola.error(
        `Signer ${account.address} has zero native balance on ${networkName}; cannot pay gas.`
      )
      process.exit(1)
    }
    consola.info(`Signer balance : ${formatEther(balance)}`)

    consola.start(
      `Sending registerPeripheryContract("${peripheryName}", ${peripheryAddress}) to ${diamondAddress}...`
    )

    const hash = await walletClient.writeContract({
      address: diamondAddress,
      abi: PERIPHERY_REGISTRY_ABI,
      functionName: 'registerPeripheryContract',
      args: [peripheryName, peripheryAddress],
    })

    consola.info(`Tx hash        : ${hash}`)
    const explorerUrl = buildExplorerTxUrl(networkName, hash)
    if (explorerUrl) consola.info(`Explorer       : ${explorerUrl}`)

    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      consola.error(`Transaction reverted in block ${receipt.blockNumber}.`)
      process.exit(1)
    }

    const eventLog = receipt.logs.find(
      (log) =>
        getAddress(log.address) === diamondAddress &&
        log.topics[0] === PERIPHERY_REGISTERED_TOPIC
    )
    if (!eventLog) {
      consola.error(
        'Transaction succeeded but no PeripheryContractRegistered event was emitted by the diamond — the Hexagate monitor will not fire.'
      )
      process.exit(1)
    }

    // Read-back catches the (unlikely) case where the event fired but storage
    // was not written as expected; without this, a silent diamondCut routing
    // change could go unnoticed here.
    const stored = await publicClient.readContract({
      address: diamondAddress,
      abi: PERIPHERY_REGISTRY_ABI,
      functionName: 'getPeripheryContract',
      args: [peripheryName],
    })
    if (getAddress(stored) !== peripheryAddress)
      consola.warn(
        `getPeripheryContract("${peripheryName}") returned ${stored}, expected ${peripheryAddress}.`
      )
    else
      consola.success(
        `Storage confirmed: ${peripheryName} -> ${stored} (block ${receipt.blockNumber})`
      )

    consola.box(
      [
        'PeripheryContractRegistered emitted. Next steps:',
        '',
        ' 1. Within ~1 minute, the Hexagate monitor',
        '    "TEST DIAMOND STAGING EMERGENCY PAUSING USING',
        '     PeripheryContractRegistered contract event" detects the log',
        '    and fires channel 109104104 (Emergency Diamond pause all PROD diamonds).',
        '',
        ' 2. That channel dispatches the production workflow',
        '    "EMERGENCY >> Pause all PROD diamonds":',
        '    https://github.com/lifinance/contracts/actions/workflows/diamondEmergencyPause.yml',
        '',
        ' 3. Verify the four observability channels also fired (see Notion section 5):',
        '    Google Group, Zenduty, Telegram, #sc-monitoring-critical.',
        '',
        ` Event topic[0] for log search: ${PERIPHERY_REGISTERED_TOPIC}`,
      ].join('\n')
    )

    process.exit(0)
  },
})

runMain(main)
