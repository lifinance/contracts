/**
 * Entry point of the repo-local solhint plugin: the list of rule classes solhint
 * instantiates for `"plugins": ["lifi"]`. Add a rule by appending its class here.
 */
const NoUntypedJsonDecode = require('./no-untyped-json-decode')

module.exports = [NoUntypedJsonDecode]
