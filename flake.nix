{
  description = "kge - knowledge graph editor: JSON files in git, FastAPI server, browser UI for humans, CLI for agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        packages = {
          # The built UI (static files); `kge serve --ui-dir` can point at this,
          # and `kge serve` picks up ui/dist automatically in a dev checkout.
          ui = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "kge-ui";
            version = "0.1.0";
            src = ./ui;

            nativeBuildInputs = [
              pkgs.nodejs_22
              pkgs.pnpm_10.configHook
            ];

            pnpmDeps = pkgs.pnpm_10.fetchDeps {
              inherit (finalAttrs) pname version src;
              fetcherVersion = 4;
              hash = "sha256-r6pbgeKixk+/nDRzmKSpAUg90wLokWKTur6BsxPSSu0=";
            };

            buildPhase = ''
              runHook preBuild
              pnpm build
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              cp -r dist $out
              runHook postInstall
            '';
          });
          default = self.packages.${system}.ui;
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.uv
            pkgs.nodejs_22
            pkgs.pnpm_10
          ];
        };

        checks = {
          ui-build = self.packages.${system}.ui;
        };
      });
}
