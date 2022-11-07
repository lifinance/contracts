PROTOC_VER=""
GEN_SOL_VER=""

# need to install and run npx prettier -w contracts

prepare_tools() {
  setup_git
}

gen_sol() {
  echo "TBD"
}

add_to_pr() {
  echo "TBD"
}

setup_git() {
  git config --global user.email "build@celer.network"
  git config --global user.name "Build Bot"
  git config --global push.default "current"
}
