#!/usr/bin/env bash

## Load env
source .env

# This script is created to assist with throughput testing of Pioneer through the LI.FI diamond.

# Get from networks (JSON-like list or comma-separated)
SRC_NETWORKS=${1:?Usage: $0 SRC_NETWORKS TO_NETWORKS TOKEN NUM_TRANSACTIONS NUM_RUNS}

# Get to networks "[optimism, arbitrum, polygon]"
TO_NETWORKS=${2:?missing TO_NETWORKS}

TOKEN=${3:?missing TOKEN}
NUM_TRANSACTIONS=${4:?missing NUM_TRANSACTIONS}
NUM_RUNS=${5:-5}


# For each network provided, run the qa script in parallel and then wait for all to finish.
for RUN in $(seq 1 $NUM_RUNS);
do
  echo "Starting run $RUN of $NUM_RUNS"
  for NET in $(echo $SRC_NETWORKS | tr -d '[]"' | tr ',' '\n');
  do
    echo "Starting QA for network: $NET"
    bash script/pioneer/pioneer-qa.sh "$NET" "$TO_NETWORKS" "$TOKEN" "$NUM_TRANSACTIONS" &
  done
  # Wait for all background processes to finish
  wait
done;

echo "All QA processes completed."
