{
  description = "malebolge: its tool set, for a devshell and the oubliette room";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "aarch64-darwin"];
    forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

    # node runs the TypeScript directly (package.json `engines`: >=24); biome,
    # eslint, tsc and vitest are npm devDependencies, reached through `npx`, so
    # they need `npm ci` and are not here.
    devToolPkgs = pkgs: with pkgs; [nodejs_24 just];

    # The patch-job runner, for the satan-runner user unit (~/flakes
    # features/satan/runner.nix): the tree's src/ with production deps only.
    runner = pkgs: let
      nodejs = pkgs.nodejs_24;
    in
      (pkgs.buildNpmPackage.override {inherit nodejs;}) {
        pname = "satan-runner";
        version = "0.0.0";
        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [./package.json ./package-lock.json ./src];
        };
        npmDepsHash = "sha256-KnOCkXCoMbp5ikH120Ain4e2xO0+SZdDOtro1mnVV0E=";
        dontNpmBuild = true; # node strips the types at load
        nativeBuildInputs = [pkgs.makeWrapper];
        # Not npmInstallHook's lib/node_modules/malebolge: node refuses to strip
        # types under a node_modules path.
        installPhase = ''
          runHook preInstall
          npm prune --omit=dev --no-save
          find node_modules -type d -empty -delete
          mkdir -p $out/lib/malebolge
          cp -r package.json src node_modules $out/lib/malebolge/
          makeWrapper ${nodejs}/bin/node $out/bin/satan-runner \
            --add-flags $out/lib/malebolge/src/runner-main.ts
          runHook postInstall
        '';
      };
  in {
    # One closure, the oubliette room's `toolsPackage`, so the VM and the
    # devshell can't drift.
    packages = forAll (pkgs: {
      dev-tools = pkgs.buildEnv {
        name = "malebolge-dev-tools";
        paths = devToolPkgs pkgs;
      };
      runner = runner pkgs;
    });

    # The built runner loads its whole module graph and refuses to start for
    # want of a config: imports resolve from the store, and it runs.
    checks = forAll (pkgs: {
      runner-starts = pkgs.runCommand "satan-runner-starts" {} ''
        export HOME=$TMPDIR XDG_RUNTIME_DIR=$TMPDIR SATAN_RUNNER_CONFIG=$TMPDIR/absent.toml
        rc=0
        ${self.packages.${pkgs.stdenv.hostPlatform.system}.runner}/bin/satan-runner 2>err || rc=$?
        cat err
        [ "$rc" = 1 ]
        grep -qF "refusing to start: config $SATAN_RUNNER_CONFIG" err
        touch $out
      '';
    });

    devShells = forAll (pkgs: {
      default = pkgs.mkShell {packages = devToolPkgs pkgs;};
    });
  };
}
