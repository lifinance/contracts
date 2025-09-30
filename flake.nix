{
  description = "LiFi development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Custom lcov 1.16 package
        lcov_1_16 = pkgs.stdenv.mkDerivation rec {
          pname = "lcov";
          version = "1.16";

          src = pkgs.fetchFromGitHub {
            owner = "linux-test-project";
            repo = "lcov";
            rev = "v${version}";
            hash = "sha256-X1T5OqR6NgTNGedH1on3+XZ7369007By6tRJK8xtmbk=";
          };

          nativeBuildInputs = with pkgs; [
            makeWrapper
            perl
          ];

          buildInputs = with pkgs; [
            perl
            python3
          ];

          perlDeps = with pkgs.perlPackages; [
            CaptureTiny
            DateTime
            DateTimeFormatW3CDTF
            DevelCover
            GD
            JSONXS
            PathTools
          ] ++ pkgs.lib.optionals (!pkgs.stdenv.hostPlatform.isDarwin) [
            pkgs.perlPackages.MemoryProcess
          ];

          strictDeps = true;

          makeFlags = [
            "PREFIX=$(out)"
            "VERSION=${version}"
            "RELEASE=1"
          ];

          preBuild = ''
            patchShebangs --build bin/* tests/*/*
          '';

          postInstall = ''
            for f in "$out"/bin/{gen*,lcov,perl2lcov}; do
              if [ -f "$f" ] && [ -x "$f" ]; then
                wrapProgram "$f" --set PERL5LIB ${pkgs.perlPackages.makeFullPerlPath perlDeps}
              fi
            done
          '';

          meta = with pkgs.lib; {
            description = "Code coverage tool that enhances GNU gcov";
            homepage = "https://github.com/linux-test-project/lcov";
            license = licenses.gpl2Plus;
            platforms = platforms.all;
          };
        };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            jq
            bc
            gum
            mongosh
            bun
            foundry
            stdenv.cc.cc.lib
            lcov_1_16  # Add custom lcov 1.16
          ];

          shellHook = ''
            export LD_LIBRARY_PATH=${
              pkgs.lib.makeLibraryPath [
                pkgs.systemd
                pkgs.stdenv.cc.cc.lib
              ]
            }:$LD_LIBRARY_PATH
          '';
        };
      }
    );
}
