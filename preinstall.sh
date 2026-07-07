#!/bin/bash

echo "Setting up the development environment..."

install_package_linux() {
  local PACKAGE=$1

  # try to use apt-get (default package manager for Debian/Ubuntu) 
  if command -v apt-get &> /dev/null; then
    echo "Installing $PACKAGE using apt-get..."
    sudo apt-get update -y
    sudo apt-get install -y "$PACKAGE"

  # try to use dnf (default package manager for Fedora/RedHat) 
  elif command -v dnf &> /dev/null; then
    echo "Installing $PACKAGE using dnf..."
    sudo dnf install -y "$PACKAGE"

  else
    echo "No recognized package manager found."
    echo "Please install $PACKAGE manually."
    exit 1
  fi
}

install_package_mac() {
  local PACKAGE=$1

  echo "Installing $PACKAGE on macOS..."
  if ! brew install "$PACKAGE"; then
    echo "Failed to install $PACKAGE"
    exit 1
  fi
}

# Detect the operating system
OS=$(uname -s)

# List of required packages
REQUIRED_PACKAGES=("jq" "bc" "gum" "mongosh")

for PACKAGE in "${REQUIRED_PACKAGES[@]}"; do
  if ! command -v "$PACKAGE" &> /dev/null; then
    echo "$PACKAGE is missing. Proceeding with installation..."
    if [[ "$OS" == "Linux" ]]; then
      if ! command -v sudo &> /dev/null; then
        echo "sudo is required but not available"
        exit 1
      fi
      echo "Detected Linux. Using apt or dnf package manager."
      install_package_linux "$PACKAGE"
    elif [[ "$OS" == "Darwin" ]]; then
      echo "Detected macOS. Using Homebrew package manager."

      # Check if Homebrew is installed
      if ! command -v brew &> /dev/null; then
        echo "Homebrew is not installed. Installing Homebrew..."
        BREW_SCRIPT=$(mktemp)
        if ! curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$BREW_SCRIPT"; then
          echo "Failed to download Homebrew install script"
          rm -f "$BREW_SCRIPT"
          exit 1
        fi
        if ! /bin/bash "$BREW_SCRIPT"; then
          echo "Failed to install Homebrew"
          rm -f "$BREW_SCRIPT"
          exit 1
        fi
        rm -f "$BREW_SCRIPT"
        eval "$("$(brew --prefix)/bin/brew" shellenv)"
      fi
      install_package_mac "$PACKAGE"
    else
      echo "Unsupported operating system: $OS"
      echo "Please install $PACKAGE manually."
      exit 1
    fi
  else
    echo "$PACKAGE is already installed."
  fi
done

echo "All necessary packages are installed."

# ------------------------------------------------------------------------------
# CodeRabbit CLI: pinned, checksum-verified install for /pr-ready
# ------------------------------------------------------------------------------
#
# Design (per #dev-sc-review feedback):
#   1. Skip entirely if `coderabbit` is already on PATH — devs are free to
#      install/upgrade the CLI themselves; we don't second-guess their setup.
#   2. When we DO install it ourselves, pin a specific version and verify the
#      downloaded binary's SHA-256 against a hardcoded constant. We bypass the
#      upstream install.sh (which doesn't verify checksums) and download the
#      release artifact directly so the trust surface is a single zip per
#      platform with a single hash.
#   3. Skipped on CI (the cloud CodeRabbit GitHub app handles CI reviews).
#   4. Soft-fail: never blocks `bun install`. A mismatch or any other error
#      surfaces a warning + manual-recovery instructions and continues.
#
# Bumping the pin:
#   See .agents/commands/pr-ready.md → "Bumping the CodeRabbit pin" for the
#   exact commands (fetch new release, compute SHA-256 for all 4 platforms,
#   update the constants below).
# ------------------------------------------------------------------------------

# Pinned CodeRabbit CLI version. Bump deliberately, not opportunistically.
CODERABBIT_PINNED_VERSION="0.4.5"

# Pinned SHA-256 of `coderabbit-<os>-<arch>.zip` for CODERABBIT_PINNED_VERSION,
# fetched from https://cli.coderabbit.ai/releases/${VERSION}/coderabbit-<os>-<arch>.zip
# Architecture slugs follow the upstream installer's convention (x64 / arm64).
function _coderabbit_expected_sha256() {
  case "$1" in
    darwin-arm64) echo "8221fe93f213d7b965d39898ea5be19c995e3b6ca879509aebb48e5318c4120d" ;;
    darwin-x64)   echo "586dbaa384b0970aacfac8b9a242038cda8206edd02da10642712fcaab2abfa3" ;;
    linux-arm64)  echo "953459e17dfaa8e0087292c074e4bcd50527266714b12e0e04eb0afa03c0fb43" ;;
    linux-x64)    echo "d9bbab0b6e41ff708596de47c2606df3820ccf6c65b5b15f0e478ef076b05ba0" ;;
    *) return 1 ;;
  esac
}

# Compute SHA-256 of a file using whichever utility is available.
function _coderabbit_sha256() {
  if command -v sha256sum &> /dev/null; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum &> /dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 1
  fi
}

# Print the post-install auth nudge if not yet authenticated.
function _coderabbit_nudge_auth() {
  command -v coderabbit &> /dev/null || return 0
  coderabbit auth status &> /dev/null && return 0
  echo ""
  echo "================================================================"
  echo "CodeRabbit CLI is installed but not authenticated."
  echo ""
  echo "One-time setup (browser flow):"
  echo "    coderabbit auth login"
  echo ""
  echo "When the browser opens, sign in with the GitHub account that"
  echo "has access to lifinance/contracts. If you get a 'no access' /"
  echo "'subscription required' error, you need a CodeRabbit seat —"
  echo "ask #dev-sc-review."
  echo ""
  echo "Full setup + troubleshooting: .agents/commands/pr-ready.md"
  echo "================================================================"
}

# Install the pinned CodeRabbit CLI version, verifying SHA-256 before extract.
# Returns 0 on success OR on any non-fatal failure (this script must not block
# bun install). On failure, prints recovery instructions and returns 0.
function install_coderabbit_cli() {
  if [[ -n "${CI:-}" ]]; then
    echo "CI environment detected — skipping CodeRabbit CLI install."
    return 0
  fi

  # Dev has it installed already → leave it alone. They own their version.
  if command -v coderabbit &> /dev/null; then
    echo "CodeRabbit CLI already installed: $(coderabbit --version 2>/dev/null || echo 'unknown version'). Skipping pinned install."
    _coderabbit_nudge_auth
    return 0
  fi

  echo "CodeRabbit CLI not found. Installing pinned version v${CODERABBIT_PINNED_VERSION} (used by /pr-ready)..."

  # Detect platform → match upstream installer's slugs (darwin/linux + x64/arm64).
  local os arch slug expected_sha
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$os" in
    darwin|linux) ;;
    *)
      echo "WARNING: unsupported OS '$os' — install CodeRabbit CLI manually per .agents/commands/pr-ready.md."
      return 0
      ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64"   ;;
    *)
      echo "WARNING: unsupported architecture '$(uname -m)' — install CodeRabbit CLI manually per .agents/commands/pr-ready.md."
      return 0
      ;;
  esac
  slug="${os}-${arch}"

  if ! expected_sha=$(_coderabbit_expected_sha256 "$slug"); then
    echo "WARNING: no pinned SHA-256 for platform '$slug' in preinstall.sh. Install CodeRabbit CLI manually per .agents/commands/pr-ready.md."
    return 0
  fi

  # Download the release artifact directly (bypassing upstream install.sh,
  # which doesn't verify checksums).
  local url tmpdir zip_path actual_sha
  url="https://cli.coderabbit.ai/releases/${CODERABBIT_PINNED_VERSION}/coderabbit-${slug}.zip"
  tmpdir=$(mktemp -d)
  zip_path="${tmpdir}/coderabbit.zip"

  if ! curl -fsSL "$url" -o "$zip_path"; then
    echo "WARNING: failed to download $url — install CodeRabbit CLI manually per .agents/commands/pr-ready.md."
    rm -rf "$tmpdir"
    return 0
  fi

  if ! actual_sha=$(_coderabbit_sha256 "$zip_path"); then
    echo "WARNING: neither sha256sum nor shasum is available; cannot verify integrity. NOT installing. Install CodeRabbit CLI manually per .agents/commands/pr-ready.md."
    rm -rf "$tmpdir"
    return 0
  fi

  if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo "ERROR: CodeRabbit CLI checksum mismatch for ${slug} v${CODERABBIT_PINNED_VERSION}."
    echo "  Expected: $expected_sha"
    echo "  Got:      $actual_sha"
    echo "  Possible causes:"
    echo "    (a) the artifact was re-published upstream (rare)"
    echo "    (b) corrupt download / MITM"
    echo "    (c) the pin in preinstall.sh is out of date"
    echo "  See .agents/commands/pr-ready.md → 'Bumping the CodeRabbit pin' to refresh."
    echo "  NOT installing. Run /pr-ready setup manually if you trust the situation."
    rm -rf "$tmpdir"
    return 0
  fi
  echo "Checksum OK (sha256: ${actual_sha:0:16}…${actual_sha: -8})."

  # Extract the single `coderabbit` binary to ~/.local/bin.
  if ! command -v unzip &> /dev/null; then
    echo "WARNING: 'unzip' is required but not installed. Install it (e.g., 'brew install unzip' / 'apt-get install unzip') and re-run 'bun install', or install CodeRabbit CLI manually per .agents/commands/pr-ready.md."
    rm -rf "$tmpdir"
    return 0
  fi
  if ! unzip -qo "$zip_path" -d "$tmpdir"; then
    echo "WARNING: failed to unzip CodeRabbit CLI archive — install manually per .agents/commands/pr-ready.md."
    rm -rf "$tmpdir"
    return 0
  fi
  if [[ ! -f "${tmpdir}/coderabbit" ]]; then
    echo "WARNING: 'coderabbit' binary not found in extracted archive — install manually per .agents/commands/pr-ready.md."
    rm -rf "$tmpdir"
    return 0
  fi

  local install_dir="${HOME}/.local/bin"
  mkdir -p "$install_dir"
  if ! mv "${tmpdir}/coderabbit" "${install_dir}/coderabbit"; then
    echo "WARNING: failed to install CodeRabbit binary into ${install_dir} — install manually per .agents/commands/pr-ready.md."
    rm -rf "$tmpdir"
    return 0
  fi
  if ! chmod +x "${install_dir}/coderabbit"; then
    echo "WARNING: failed to mark ${install_dir}/coderabbit executable — install manually per .agents/commands/pr-ready.md."
    rm -rf "$tmpdir"
    return 0
  fi
  rm -rf "$tmpdir"

  if ! command -v coderabbit &> /dev/null; then
    echo "WARNING: CodeRabbit CLI installed at ${install_dir}/coderabbit but not on PATH. Add to your shell rc: export PATH=\"\$HOME/.local/bin:\$PATH\" — then re-open the shell."
  else
    echo "CodeRabbit CLI installed: $(coderabbit --version 2>/dev/null || echo 'unknown version')."
  fi
  _coderabbit_nudge_auth
  return 0
}

install_coderabbit_cli
