# include .env file and export its env vars
# (-include to ignore error if it does not exist)
-include .env

.PHONY: all test

# deps
update:; forge update

# Build & test
build         :; forge build
test          :; forge test --fork-url ${ETH_NODE_URI_MAINNET} --fork-block-number ${FORK_NUMBER} -vv --no-match-contract ".*(Polygon)"
test-polygon  :; forge test --fork-url ${ETH_NODE_URI_POLYGON} --fork-block-number ${POLYGON_FORK_NUMBER} -vv --match-contract ".*(Polygon)"
trace         :; forge test --fork-url ${ETH_NODE_URI_MAINNET} --fork-block-number ${FORK_NUMBER} -vvv
watch         :; forge test --watch src test --fork-url ${ETH_NODE_URI_MAINNET} --fork-block-number ${FORK_NUMBER} -vvvv
clean         :; forge clean
snapshot      :; forge snapshot --fork-url ${ETH_NODE_URI_MAINNET} --fork-block-number ${FORK_NUMBER} --match-path "test/solidity/Gas/**/*"
