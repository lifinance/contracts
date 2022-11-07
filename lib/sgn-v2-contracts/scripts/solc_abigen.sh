# script for solc/abigen solidity files
# below env variables are set by github action

# PRID: ${{ github.event.number }}
# BRANCH: ${{ github.head_ref }}
# GH_TOKEN: ${{ secrets.GH_TOKEN }}

SOLC_VER="v0.8.9+commit.e5eed63a"
OPENZEPPELIN="openzeppelin-contracts-4.5.0"          # if change, also need to change the url in dld_solc
GETH_VER="geth-alltools-linux-amd64-1.10.7-12f0ff40" # for abigen
CNTRDIR="contracts"                                  # folder name for all contracts code
GO_REPO=https://${GH_TOKEN}@github.com/celer-network/sgn-v2

# xx.sol under contracts/, no need for .sol suffix, if sol file is in subfolder, just add the relative path
solFiles=(
  staking/Staking
  staking/SGN
  staking/StakingReward
  staking/Govern
  staking/Viewer
  liquidity-bridge/FarmingRewards
  interfaces/ISigsVerifier
)

dld_solc() {
  curl -L "https://binaries.soliditylang.org/linux-amd64/solc-linux-amd64-${SOLC_VER}" -o solc && chmod +x solc
  sudo mv solc /usr/local/bin/
  # only need oz's contracts subfolder, files will be at $CNTRDIR/$OPENZEPPELIN/contracts
  curl -L "https://github.com/OpenZeppelin/openzeppelin-contracts/archive/v4.5.0.tar.gz" | tar -xz -C $CNTRDIR $OPENZEPPELIN/contracts/
}

dld_abigen() {
  curl -sL https://gethstore.blob.core.windows.net/builds/$GETH_VER.tar.gz | sudo tar -xz -C /usr/local/bin --strip 1 $GETH_VER/abigen
  sudo chmod +x /usr/local/bin/abigen
}

# MUST run this under $CNTRDIR
gen_dtHelper() {
  pushd libraries
  DTFILE="staking/DataTypes.sol"
  CTRNAME="DtHelper"
  SOLFILE="$CTRNAME.sol"
  cat >$SOLFILE <<EOF
// SPDX-License-Identifier: MIT
// Auto generated. DO NOT MODIFY MAUALLY
pragma solidity >=0.8.0;
pragma abicoder v2;
import {DataTypes as dt} from "./$DTFILE";
contract $CTRNAME {
EOF

  grep -Eo "struct [^ ]*" $DTFILE | cut -d' ' -f2 | while read STRUCT; do
    echo "  function $STRUCT(dt.$STRUCT calldata _in) public pure {}" >>$SOLFILE
  done

  echo "}" >>$SOLFILE
  popd
}

# MUST run this under repo root
# will generate a single combined.json under $CNTRDIR
run_solc() {
  pushd $CNTRDIR
  gen_dtHelper
  solc --base-path $PWD --allow-paths . --overwrite --optimize --optimize-runs 800 --pretty-json --combined-json abi,bin -o . '@openzeppelin/'=$OPENZEPPELIN/ \
    $(for f in ${solFiles[@]}; do echo -n "$f.sol "; done)
  no_openzeppelin combined.json # combined.json file name is hardcoded in solc
  popd
}

# remove openzeppelin from combined.json. solc will also include all openzeppelin in combined.json but we don't want to generate go for them
# $1 is the json file from solc output
no_openzeppelin() {
  jq '."contracts"|=with_entries(select(.key|test("^openzeppelin")|not))' $1 >tmp.json
  mv tmp.json $1
}

# MUST run this under contract repo root
run_abigen() {
  PR_COMMIT_ID=$(git rev-parse --short HEAD)
  git clone $GO_REPO
  pushd sgn-v2
  git fetch
  BR="$BRANCH-binding"
  git checkout $BR || git checkout -b $BR

  mkdir -p eth
  abigen -combined-json ../$CNTRDIR/combined.json -pkg eth -out eth/bindings.go

  #pushd eth
  #go build # make sure eth pkg can build
  #popd

  if [[ $(git status --porcelain) ]]; then
    echo "Sync-ing go binding"
    git add .
    git commit -m "Sync go binding based on contract PR $PRID" -m "contract repo commit: $PR_COMMIT_ID"
    git push origin $BR
  fi
  popd
}

setup_git() {
  git config --global user.email "build@celer.network"
  git config --global user.name "Build Bot"
  git config --global push.default "current"
}
