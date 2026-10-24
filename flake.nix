{
  description = "malebolge: its tool set, for a devshell and the oubliette room";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.doctrine.url = "github:davidlee/doctrine";
  # The host-side bwrap jails an agent works on this repo in (`jailed-*`).
  inputs.agents.url = "github:davidlee/nix-config?dir=flakes/agents";

  outputs = {
    self,
    nixpkgs,
    doctrine,
    agents,
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "aarch64-darwin"];
    forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

    # node runs the TypeScript directly (package.json `engines`: >=24); biome,
    # eslint, tsc and vitest are npm devDependencies, reached through `npx`, so
    # they need `npm ci` and are not here.
    shellPkgs = pkgs: (with pkgs; [nodejs_24 just]);

    # The room's tool set, and what the flake exports as `dev-tools` for
    # oubliette capsules: the devshell's tools plus doctrine, which is how the
    # patch runner reads a repo's boot inside the room (design SL-026 §4.3).
    # Doctrine publishes packages for x86_64-linux and aarch64-darwin only, so
    # it is included only where its flake has this system.
    devToolPkgs = pkgs:
      shellPkgs pkgs
      ++ pkgs.lib.optional (doctrine.packages ? ${pkgs.stdenv.hostPlatform.system})
      doctrine.packages.${pkgs.stdenv.hostPlatform.system}.default;

    # Linux only (bwrap). Every jail shares one posture; only the agent
    # differs. No provider key enters a jail: each reaches models through the
    # LLM gateway on the shared `pi` key. A jail gets `shellPkgs`, not
    # `devToolPkgs`: doctrine comes from the host's own install, which the
    # agents library binds read-only (`hostDoctrine`, on by default) and keeps
    # runnable by binding the store closure its ELF needs. A pinned copy in
    # `extraPkgs` would be prepended to PATH ahead of that bind and win —
    # leaving the jail on a doctrine the host does not run.
    jails = pkgs: let
      jailLib = agents.lib.${pkgs.stdenv.hostPlatform.system}.mkJailedAgents {};
      inherit (jailLib) combinators;

      # Doctrine bakes `current_exe()` into every file it writes, so the jail
      # must present it at the host's own path: any other path (the library's
      # /run/doctrine-bin) makes the recorded binary flip with the side of the
      # wall the write happened on. `add-path` interpolates raw — PATH is shell
      # text in the wrapper — so the quoted `$HOME` reaches the runtime shell,
      # where it can expand; a Nix-side path could not.
      doctrineDir = "\"$HOME/.local/share/doctrine/bin\"";
      doctrineOptions = [
        # A directory, not the file: `cargo install` renames a new binary over
        # the old inode, and a file bind would pin the deleted one.
        (combinators.try-ro-bind
          (combinators.noescape "~/.local/share/doctrine/bin")
          (combinators.noescape doctrineDir))
        (combinators.add-path doctrineDir)
      ];

      # Belongs upstream, in `hostDoctrineOptions` of nix-config's
      # flakes/agents/jailed-agents.nix — its /run/doctrine-bin destination is
      # what every consumer inherits. Bind at the host path instead, and find
      # doctrine through that same path:
      #   (try-ro-bind (noescape hostDoctrineDir)
      #     (noescape "\"$HOME/.local/share/doctrine/bin\""))
      #   (add-path "\"$HOME/.local/share/doctrine/bin\"")
      # After which `doctrineOptions` here goes away.
      mkJail = maker: args:
        maker ({
            profile = "specDev";
            extraPkgs = shellPkgs pkgs;
            gateway = jailLib.gatewayClient "pi";
            extraOptions = doctrineOptions;
          }
          // args);
    in
      pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
        jailed-pi = mkJail jailLib.makeJailedPi {
          allowSelfAsSubagent = true;
          maxSubagentDepth = 2;
        };
        jailed-pi-research = mkJail jailLib.makeJailedPi {
          name = "pi-research";
          profile = "research";
          allowSelfAsSubagent = true;
        };
        jailed-claude = mkJail jailLib.makeJailedClaude {
          allowSelfAsSubagent = true;
          subagents = ["pi"];
          maxSubagentDepth = 2;
        };
        jailed-shell = mkJail jailLib.makeJailedAgent {
          name = "shell";
          agent = pkgs.zsh;
          subagents = ["pi" "claude"];
        };
      };

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
        npmDepsHash = "sha256-FH4EDWH2a8mkOBiYwz6SI0MfDAZoZRBWB1oxSL37uIM=";
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
    # One closure for the room — oubliette's `toolsPackage` and the exported
    # `dev-tools` are the same set — so the two can't drift.
    packages = forAll (pkgs:
      jails pkgs
      // {
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
      default = pkgs.mkShell {
        packages = shellPkgs pkgs ++ builtins.attrValues (jails pkgs);
      };
    });
  };
}
