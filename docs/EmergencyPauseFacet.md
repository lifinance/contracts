# EmergencyPauseFacet

## How it works

The EmergencyPauseFacet is an admin-only facet. Its purpose is to provide a fast yet secure way to respond to suspicious transactions and smart contract activity by either pausing the whole diamond or by removing one specific facet. This can be done from a non-multisig account (i.e.: the 'PauserWallet') to ensure fast execution. The unpausing of the contract as well as adding any new facets is still only possible through the multisig owner wallet for added security.

## Public Methods

- `function removeFacet(address _facetAddress)`
  - Removes the given facet from the diamond
- `function pauseDiamond()`
  - Pauses the diamond by redirecting all function selectors to EmergencyPauseFacet
- `function unpauseDiamond(address[] calldata _blacklist)`
  - Unpauses the diamond by reactivating all formerly registered facets except for the facets in '\_blacklist'
