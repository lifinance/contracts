# Adding a New Bridge Integration

## Introduction

All bridges integrated into the [LI.FI](https://li.finance) Diamond contract follow the same basic pattern. To add a new integration follow these steps.

1. Clone this repository
2. Run `yarn install`
3. Run `yarn codegen facet` and follow the prompts

This will create all the required files to add a new bridge integration. The structure will look like this.

```bash
├── config
│   └── foobar.json # This is the config file for the bridge
├── docs
│   └── FoobarFacet.md # This is the documentation for the bridge
├── script
│   ├── deploy
│   │   ├── facets
│   │   │   ├── DeployFoobarFacet.s.sol # This is the deployment script for the bridge
│   │   │   └── UpdateFoobarFacet.s.sol # This is the script that adds the bridge to the Diamond
├── src
│   ├── Facets
│   │   └── FoobarFacet.sol # This is the bridge contract
├── test
│   └── solidity
│       └── Facets
│           └── FoobarFacet.t.sol # This is the test for the bridge
```

4. Implement the bridge logic as required, add any tests and configuration
5. Note any contract-specific deployment requirements and add them to `script/deploy/resources/deployRequirements.json`
6. Submit a PR to this repository
