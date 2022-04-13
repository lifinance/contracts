import funcSignatures from '../utils/approvedFunctions'

type DEXAllowedFunctionSignatures = string[]

const config: DEXAllowedFunctionSignatures = [...funcSignatures]
export default config
