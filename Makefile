# include .env file and export its env vars
# (-include to ignore error if it does not exist)
-include .env

.PHONY: all test

# deps
update:; forge update

# Build & test
build         		: clean
	forge build
test          		:; forge test -vvv
coverage      		:; forge coverage
trace         		:; forge test -vvvv
watch         		:; forge test --watch src test -vvv
clean         		:; forge clean; rm -rf typechain/*
snapshot      		:; forge snapshot --match-path "test/solidity/Gas/**/*" -vvv
