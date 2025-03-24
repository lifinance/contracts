{
  description = "LiFi development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            bun
            foundry
            stdenv.cc.cc.lib
          ];
          
          shellHook = ''
            export LD_LIBRARY_PATH=${pkgs.lib.makeLibraryPath [pkgs.systemd pkgs.stdenv.cc.cc.lib]}:$LD_LIBRARY_PATH
          '';
        };
      }
    );
}
