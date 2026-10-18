{
  description = "malebolge: its tool set, for a devshell and the oubliette room";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {nixpkgs, ...}: let
    systems = ["x86_64-linux" "aarch64-linux" "aarch64-darwin"];
    forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

    # node runs the TypeScript directly (package.json `engines`: >=24); biome,
    # eslint, tsc and vitest are npm devDependencies, reached through `npx`, so
    # they need `npm ci` and are not here.
    devToolPkgs = pkgs: with pkgs; [nodejs_24 just];
  in {
    # One closure, the oubliette room's `toolsPackage`, so the VM and the
    # devshell can't drift.
    packages = forAll (pkgs: {
      dev-tools = pkgs.buildEnv {
        name = "malebolge-dev-tools";
        paths = devToolPkgs pkgs;
      };
    });

    devShells = forAll (pkgs: {
      default = pkgs.mkShell {packages = devToolPkgs pkgs;};
    });
  };
}
