#!/bin/bash

echo "Setting up the development environment..."

# Function to install a package if not already installed
install_package_linux() {
  PACKAGE=$1
  if ! command -v $PACKAGE &> /dev/null; then
    echo "Installing $PACKAGE on Linux..."
    sudo apt-get update -y
    sudo apt-get install -y $PACKAGE
  else
    echo "$PACKAGE is already installed."
  fi
}

install_package_mac() {
  PACKAGE=$1
  if ! command -v $PACKAGE &> /dev/null; then
    echo "Installing $PACKAGE on macOS..."
    brew install $PACKAGE
  else
    echo "$PACKAGE is already installed."
  fi
}

# Detect the operating system
OS=$(uname -s)

if [[ "$OS" == "Linux" ]]; then
  echo "Detected Linux. Using apt package manager."
  install_package_linux jq
  install_package_linux bc
elif [[ "$OS" == "Darwin" ]]; then
  echo "Detected macOS. Using Homebrew package manager."

  # Check if Homebrew is installed
  if ! command -v brew &> /dev/null; then
    echo "Homebrew is not installed. Installing Homebrew..."
    # Download script first to allow inspection
    BREW_SCRIPT=$(mktemp)
    if ! curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$BREW_SCRIPT"; then
      echo "Failed to download Homebrew install script"
      rm -f "$BREW_SCRIPT"
      exit 1
    fi
    # Execute the downloaded script
    if ! /bin/bash "$BREW_SCRIPT"; then
      echo "Failed to install Homebrew"
      rm -f "$BREW_SCRIPT"
      exit 1
    fi
    rm -f "$BREW_SCRIPT"
    # Add Homebrew to PATH for immediate use
    eval "$("$(brew --prefix)/bin/brew" shellenv)"
  fi

  install_package_mac jq
  install_package_mac bc
else
  echo "Unsupported operating system: $OS"
  echo "Please install jq and bc manually."
  exit 1
fi

echo "All necessary packages are installed."