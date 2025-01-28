import { ContractNetworksConfig } from '@safe-global/protocol-kit'

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
