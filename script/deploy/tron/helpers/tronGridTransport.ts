import { MAX_RETRIES, RETRY_DELAY } from '../../shared/constants'
import { TRON_PRO_API_KEY_HEADER } from '../constants'
import type {
  IViemRpcTransportConfig,
  IViemRpcTransportConfigBase,
} from '../types'

import { isTronGridRpcUrl } from './isTronGridRpcUrl'

/**
 * TronGrid JSON-RPC: optional `TRON-PRO-API-KEY`, plus viem HTTP retries tuned with
 * {@link MAX_RETRIES} and {@link RETRY_DELAY} from deploy shared constants (429 backoff).
 */
export function applyTronGridViemTransportExtras(
  base: IViemRpcTransportConfigBase
): IViemRpcTransportConfig {
  if (!isTronGridRpcUrl(base.url)) return base

  let fetchOptions = base.fetchOptions
  const apiKey = process.env.TRONGRID_API_KEY?.trim()
  if (apiKey) {
    fetchOptions = {
      ...fetchOptions,
      headers: {
        ...fetchOptions?.headers,
        [TRON_PRO_API_KEY_HEADER]: apiKey,
      },
    }
  }

  return {
    url: base.url,
    fetchOptions,
    retryCount: MAX_RETRIES + 5,
    retryDelay: RETRY_DELAY,
  }
}
