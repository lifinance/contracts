import { fetchQuote, swapFromEvm, Quote } from '@mayanfinance/swap-sdk'
import { BigNumber } from 'ethers'
import { parseUnits } from 'ethers/lib/utils'

const main = async () => {
  const quote: Quote = await fetchQuote({
    amount: 150,
    fromToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    toToken: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    fromChain: 'ethereum',
    toChain: 'polygon',
    slippage: 3,
  })

  const swapFee = getAmountOfFractionalAmount(
    quote.swapRelayerFee,
    Math.min(8, quote.fromToken.decimals)
  )
  const redeemFee = getAmountOfFractionalAmount(
    quote.redeemRelayerFee,
    Math.min(8, quote.toToken.decimals)
  )
  const refundFee = getAmountOfFractionalAmount(
    quote.refundRelayerFee,
    Math.min(8, quote.fromToken.decimals)
  )
  console.info('swapFee', swapFee.toString())
  console.info('redeemFee', redeemFee.toString())
  console.info('refundFee', refundFee.toString())
}

main()
  .then(() => {
    console.log('Success')
    process.exit(0)
  })
  .catch((error) => {
    console.error('error')
    console.error(error)
    process.exit(1)
  })

function getAmountOfFractionalAmount(
  amount: string | number,
  decimals: string | number
): BigNumber {
  const fixedAmount = Number(amount).toFixed(Math.min(8, Number(decimals)))
  return parseUnits(fixedAmount, Number(decimals))
}
