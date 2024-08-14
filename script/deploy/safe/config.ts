import { ContractNetworksConfig } from '@safe-global/protocol-kit'
import { immutableZkEvm } from 'viem/chains'

export const safeApiUrls: Record<string, string> = {
  mainnet: 'https://safe-transaction-mainnet.safe.global/api',
  arbitrum: 'https://safe-transaction-arbitrum.safe.global/api',
  aurora: 'https://safe-transaction-aurora.safe.global/api',
  avalanche: 'https://safe-transaction-avalanche.safe.global/api',
  base: 'https://safe-transaction-base.safe.global/api',
  blast: 'https://transaction.blast-safe.io/api',
  boba: 'https://safe-transaction.mainnet.boba.network/api',
  bsc: 'https://safe-transaction-bsc.safe.global/api',
  celo: 'https://safe-transaction-celo.safe.global/api',
  fantom: 'https://safe-txservice.fantom.network/api',
  fraxtal: 'https://transaction-frax.safe.optimism.io/api',
  fuse: 'https://transaction-fuse.safe.fuse.io/api',
  gnosis: 'https://safe-transaction-gnosis-chain.safe.global/api',
  gravity: 'https://safe.gravity.xyz/txs/api',
  immutablezkevm: 'https://transaction.safe.immutable.com/api',
  linea: 'https://transaction.safe.linea.build/api',
  mantle: 'https://transaction.multisig.mantle.xyz/api',
  metis: 'https://metissafe.tech/txs/api',
  mode: 'https://transaction-mode.safe.optimism.io/api',
  moonbeam: 'https://transaction.multisig.moonbeam.network/api',
  moonriver: 'https://transaction.moonriver.multisig.moonbeam.network/api',
  optimism: 'https://safe-transaction-optimism.safe.global/api',
  polygon: 'https://safe-transaction-polygon.safe.global/api',
  polygonzkevm: 'https://safe-transaction-zkevm.safe.global/api',
  rootstock: 'https://transaction.safe.rootstock.io/api',
  scroll: 'https://safe-transaction-scroll.safe.global/api',
  sei: 'https://transaction.sei-safe.protofire.io/api',
  zksync: 'https://safe-transaction-zksync.safe.global/api',
}

export const safeAddresses: Record<string, string> = {
  mainnet: '0x37347dD595C49212C5FC2D95EA10d1085896f51E',
  arbitrum: '0x9e606d0d2BbA344b911e2F4Eab95d9235A83fe15',
  aurora: '0xC7291F249424A35b17976F057D2C97B30c92b88C',
  avalanche: '0x27d4eb2854d93a1A7Df8e2aeD1a535b080a6f6e4',
  base: '0x1F6974C11B833Eb52ea07E0B442510165D87d82e',
  blast: '0xdf61270fDC1A892874Fd3C0143A0A4CBA74F4EF1',
  boba: '0x05d34Bd70E0CBf8b82423d0C2ee8b2a8f02E4128',
  bsc: '0x20B6b31D76E054C3e4de6154fEca385Ca58c7C15',
  celo: '0xa89a87986e8ee1Ac8fDaCc5Ac91627010Ec9f772',
  fantom: '0x9B325B1c43BB3c018FcDB24A64E05EF4B8B8057b',
  fraxtal: '0xa89a87986e8ee1Ac8fDaCc5Ac91627010Ec9f772',
  fuse: '0x5336e97bA7332FAC20281Bda8B790c8892245Ded',
  gnosis: '0x2bC523875b59A1Ddd03CEB1F1b28c5B0e8e6654A',
  gravity: '0x245B16CaCE8730b009c5352186DcE7d73c3037A1',
  immutablezkevm: '0xa89a87986e8ee1Ac8fDaCc5Ac91627010Ec9f772',
  linea: '0xdf61270fDC1A892874Fd3C0143A0A4CBA74F4EF1',
  mantle: '0xa89a87986e8ee1Ac8fDaCc5Ac91627010Ec9f772',
  metis: '0x925cD8289Ac2d617F52974da8338867f3bB62d56',
  mode: '0xdf61270fDC1A892874Fd3C0143A0A4CBA74F4EF1',
  moonbeam: '0xB51E43CeCAB8A42cD6225e16C9C3a3ba1A76871A',
  moonriver: '0xfC78B018B4daD77351095f00D92934A9A851DA34',
  optimism: '0xa8892eA3fdDeF2aa8AfB1E3643a3284f978A5114',
  polygon: '0x8BCC385948C73736423D38cc567cFEdE0F1826A3',
  polygonzkevm: '0x9575B9fC42dec56D3772B3df5DA047a1f1D55582',
  rootstock: '0xdf61270fDC1A892874Fd3C0143A0A4CBA74F4EF1',
  scroll: '0xdf61270fDC1A892874Fd3C0143A0A4CBA74F4EF1',
  sei: '0xdf61270fDC1A892874Fd3C0143A0A4CBA74F4EF1',
  zksync: '0x02f1272aEaCaf7BD8b30278bc2AA381Cc623A744',
}

export const getSafeUtilityContracts = (chainId: number) => {
  let contractNetworks: ContractNetworksConfig
  switch (chainId) {
    case 288:
    case 1088:
    case 13371:
      // Boba, Metis, IMX
      contractNetworks = {
        [chainId.toString()]: {
          multiSendAddress: '0x998739BFdAAdde7C933B942a68053933098f9EDa',
          safeProxyFactoryAddress: '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC',
          safeSingletonAddress: '0x69f4D1788e39c87893C980c06EdF4b7f686e2938',
          multiSendCallOnlyAddress:
            '0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B',
          fallbackHandlerAddress: '0x017062a1dE2FE6b99BE3d9d37841FeD19F573804',
          signMessageLibAddress: '0x98FFBBF51bb33A056B08ddf711f289936AafF717',
          createCallAddress: '0xB19D6FFc2182150F8Eb585b79D4ABcd7C5640A9d',
          simulateTxAccessorAddress:
            '0x727a77a074D1E6c4530e814F89E618a3298FC044',
        },
      }
      break
    case 324:
      // zkSync
      contractNetworks = {
        [chainId.toString()]: {
          multiSendAddress: '0x0dFcccB95225ffB03c6FBB2559B530C2B7C8A912',
          safeProxyFactoryAddress: '0xDAec33641865E4651fB43181C6DB6f7232Ee91c2',
          safeSingletonAddress: '0xB00ce5CCcdEf57e539ddcEd01DF43a13855d9910',
          multiSendCallOnlyAddress:
            '0xf220D3b4DFb23C4ade8C88E526C1353AbAcbC38F',
          fallbackHandlerAddress: '0x2f870a80647BbC554F3a0EBD093f11B4d2a7492A',
          signMessageLibAddress: '0x357147caf9C0cCa67DfA0CF5369318d8193c8407',
          createCallAddress: '0xcB8e5E438c5c2b45FbE17B02Ca9aF91509a8ad56',
          simulateTxAccessorAddress:
            '0x4191E2e12E8BC5002424CE0c51f9947b02675a44',
        },
      }
      break
    default:
      contractNetworks = {
        [chainId.toString()]: {
          multiSendAddress: '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526',
          safeProxyFactoryAddress: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
          safeSingletonAddress: '0x41675C099F32341bf84BFc5382aF534df5C7461a',
          multiSendCallOnlyAddress:
            '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
          fallbackHandlerAddress: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
          signMessageLibAddress: '0xd53cd0aB83D845Ac265BE939c57F53AD838012c9',
          createCallAddress: '0x9b35Af71d77eaf8d7e40252370304687390A1A52',
          simulateTxAccessorAddress:
            '0x3d4BA2E0884aa488718476ca2FB8Efc291A46199',
        },
      }
  }

  return contractNetworks
}
