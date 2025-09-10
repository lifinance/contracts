# Whitelist Manager Facet

## How It Works

The Whitelist Manager Facet is used to approve/unapprove addresses for use in various protocol interactions. It reads and writes from the global storage defined in [LibStorage](./LibStorage.md).

Facets that need to verify if an address is allowed can check the whitelist before making any interactions with it.

## Caution

The Whitelist Manager manages which contracts and functions can be executed through the LI.FI main contract. This can be updated by a single admin key which if compromised could lead to malicious code being added to the allow list.
