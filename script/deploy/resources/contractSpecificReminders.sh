#!/bin/bash

# This file contains contract-specific information to keep in mind when deploying this contract
# e.g. precondition requirements (contract XY must be deployed before, etc.)

# EXAMPLE:
FeeCollector="Please do not forget to add the new contract address to whitelisted DEXs before using it"
GasZipPeriphery="Please do not forget to add the new contract address to whitelisted DEXs before using it"
LiFiDEXAggregator="Please do not forget to add the new contract address to whitelisted DEXs before using it"
TokenWrapper="Please do not forget to add the new contract address to whitelisted DEXs before using it"
Executor="When redeploying Executor please also redeploy all contracts that have hardcoded Executor address (e.g. all Receiver... contracts)"
ERC20Proxy="When redeploying ERC20Proxy please also redeploy Executor, and then all contracts that depend on Executor (e.g. all Receiver... contracts)"
LiFiDiamond="When redeploying LiFiDiamond please also redeploy LiFiTimelockController"
LiFiDEXAggregator="When redeploying LiFiDEXAggregator please also redeploy GasZipPeriphery"
