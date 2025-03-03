import 'dotenv/config'

export function node_url(networkName: string): string {
  if (networkName) {
    const uri = process.env['ETH_NODE_URI_' + networkName.toUpperCase()]
    if (uri && uri !== '') {
      return uri
    }
  }

  if (networkName === 'localhost') {
    // do not use ETH_NODE_URI
    return 'http://localhost:8545' // [pre-commit-checker: not a secret]
  }

  let uri = process.env.ETH_NODE_URI
  if (uri) {
    uri = uri.replace('{{networkName}}', networkName)
  }
  if (!uri || uri === '') {
    // throw new Error(`environment variable "ETH_NODE_URI" not configured `);
    return ''
  }
  if (uri.indexOf('{{') >= 0) {
    throw new Error(
      `invalid uri or network not supported by node provider : ${uri}`
    )
  }
  return uri
}
