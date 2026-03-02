{
  description = "Hodor - AI-powered PR review tool";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
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
            nodejs_22
            gh
            glab
          ];

          shellHook = ''
            echo "Hodor development environment loaded (Node.js $(node --version))"
            echo "Run: npx tsx src/cli.ts <url>"
          '';
        };
      }
    );
}
