{
  description = "A proof-of-compile partial compiler for Bend 2";

  inputs = {
    nixpkgs.url = "github:cachix/devenv-nixpkgs/rolling";
    systems.url = "github:nix-systems/default";

    devenv.url = "github:cachix/devenv";
    devenv.inputs.nixpkgs.follows = "nixpkgs";

    bend-categories = {
      url = "git+https://gitlab.outstandinglabs.ai/o1lo01ol1o/bend-categories.git?ref=main";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.systems.follows = "systems";
      inputs.devenv.follows = "devenv";
      inputs.bend-src.follows = "bend-src";
    };

    bend-src = {
      # The fork's checker capability (SPEC-incremental-compilation.md).
      url = "github:o1lo01ol1o/bend/expose-book-state-api";
      flake = false;
    };

    bend-hashes-src = {
      url = "github:victormeloasm/bend-hashes/main";
      flake = false;
    };
  };

  nixConfig = {
    extra-trusted-public-keys = "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=";
    extra-substituters = "https://devenv.cachix.org";
  };

  outputs =
    inputs@{
      self,
      nixpkgs,
      devenv,
      systems,
      bend-categories,
      bend-src,
      bend-hashes-src,
      ...
    }:
    let
      bendVersion = "2.0.25";
      forEachSystem = nixpkgs.lib.genAttrs (import systems);
      checkScript = ''
        set -euo pipefail
        test "$(bend version)" = "bend ${bendVersion}"
        test -f "$BEND2_SRC/main.ts"
        test -f "$BEND_CATEGORIES_SRC/flake.nix"
        test -f "$BEND_HASHES_SRC/main.bend"

        tmp_dir="$(mktemp -d)"
        trap 'rm -rf "$tmp_dir"' EXIT
        cat > "$tmp_dir/hash-smoke.bend" <<EOF
        import $BEND_HASHES_SRC/main.bend as Hashes

        def hash_smoke() -> String:
          Hashes.SHA256.text("proof-of-compile")
        EOF
        bend "$tmp_dir/hash-smoke.bend" --check-only | grep -q '^All terms check'

        cat > "$tmp_dir/api-smoke.ts" <<EOF
        import * as Bend from "$BEND2_SRC/bend.ts";
        import { book_read } from "$BEND2_SRC/main.ts";

        const base = await book_read(Bend.BASE_BEND);
        const resumed = await book_read("$tmp_dir/hash-smoke.bend", base);
        if (resumed.book === base.book || resumed.seen === base.seen) {
          throw new Error("book_read did not copy the unsafe seed state");
        }
        if (resumed.book.tlds.hash_smoke === undefined) {
          throw new Error("book_read did not check the suffix");
        }
        EOF
        bun "$tmp_dir/api-smoke.ts"
      '';
    in
    {
      packages = forEachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          bend = pkgs.stdenvNoCC.mkDerivation {
            pname = "bend";
            version = "${bendVersion}-unstable";
            src = bend-src;

            nativeBuildInputs = [ pkgs.makeWrapper ];

            dontBuild = true;
            installPhase = ''
              runHook preInstall

              mkdir -p "$out/bin" "$out/share/bend"
              cp -R bend2 guide "$out/share/bend/"
              makeWrapper ${pkgs.bun}/bin/bun "$out/bin/bend" \
                --add-flags "$out/share/bend/bend2/main.ts" \
                --prefix PATH : ${nixpkgs.lib.makeBinPath [ pkgs.clang ]}

              runHook postInstall
            '';

            meta = {
              description = "Dependently typed, affine, parallel programming language";
              homepage = "https://github.com/o1lo01ol1o/bend";
              license = nixpkgs.lib.licenses.asl20;
              mainProgram = "bend";
              platforms = nixpkgs.lib.platforms.unix;
            };
          };
          bendHashes = pkgs.stdenvNoCC.mkDerivation {
            pname = "bend-hashes";
            version = "0-unstable";
            src = bend-hashes-src;

            dontBuild = true;
            installPhase = ''
              runHook preInstall

              mkdir -p "$out/share/bend"
              cp -R bend2/hashes "$out/share/bend/hashes"

              runHook postInstall
            '';

            meta = {
              description = "Pure Bend cryptographic hash functions";
              homepage = "https://github.com/victormeloasm/bend-hashes";
              license = nixpkgs.lib.licenses.asl20;
              platforms = nixpkgs.lib.platforms.unix;
            };
          };
          source = nixpkgs.lib.cleanSourceWith {
            src = self;
            filter =
              path: type:
              let
                relative = nixpkgs.lib.removePrefix "${self.outPath}/" (toString path);
              in
              type == "directory" || builtins.match "(bend|foreign|src)(/.*)?" relative != null;
          };
          proofOfCompile = pkgs.stdenvNoCC.mkDerivation {
            pname = "proof-of-compile";
            version = "0.1.0";
            src = source;

            nativeBuildInputs = [
              bend
              pkgs.bun
              pkgs.makeWrapper
            ];

            buildPhase = ''
              runHook preBuild

              mkdir -p vendor dist
              ln -s ${bendHashes}/share/bend/hashes vendor/bend-hashes
              bend bend/App.bend --check-only
              bun src/build-bend-lib.ts \
                ${bend}/share/bend/bend2 \
                bend/App.bend \
                dist/app-lib.js

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              app="$out/libexec/proof-of-compile"
              mkdir -p "$app" "$out/bin"
              cp -R src "$app/src"
              cp dist/app-lib.js "$app/app-lib.js"
              makeWrapper ${pkgs.bun}/bin/bun "$out/bin/proof-of-compile" \
                --add-flags "$app/src/cli.ts" \
                --set POC_APP_LIB "$app/app-lib.js" \
                --set POC_BEND2_SOURCE ${bend}/share/bend/bend2 \
                --set POC_HASHES_SOURCE ${bendHashes}/share/bend/hashes
              ln -s proof-of-compile "$out/bin/poc"

              runHook postInstall
            '';

            doInstallCheck = true;
            nativeInstallCheckInputs = [ pkgs.bun ];
            installCheckPhase = ''
              runHook preInstallCheck

              export TMPDIR="$PWD/tmp"
              mkdir -p "$TMPDIR/project"
              cat > "$TMPDIR/project/A.bend" <<'EOF'
              import Base
              def value() -> U32:
                20
              EOF
              cat > "$TMPDIR/project/B.bend" <<'EOF'
              import Base
              def value() -> U32:
                22
              EOF
              cat > "$TMPDIR/project/Main.bend" <<'EOF'
              import Base
              import ./A.bend as A
              import ./B.bend as B
              def main() -> IO(Unit):
                IO.print("proof-of-compile smoke test")
              EOF
              "$out/bin/proof-of-compile" build "$TMPDIR/project/Main.bend" \
                --output "$TMPDIR/output.js" --target js \
                | grep -q 'built and cached artifact'

              # Invalidate only the last direct import. The longest valid
              # prefix is Base + A, so exactly B must be rechecked.
              printf '\n# changed after prefix checkpoint\n' >> "$TMPDIR/project/B.bend"
              POC_DEBUG=1 "$out/bin/proof-of-compile" build \
                "$TMPDIR/project/Main.bend" \
                --output "$TMPDIR/output.js" --target js \
                > "$TMPDIR/rebuild.out" 2> "$TMPDIR/rebuild.err"
              grep -q 'built and cached artifact' "$TMPDIR/rebuild.out"
              grep -q 'resumePrefix rank=1 remainingSteps=1' "$TMPDIR/rebuild.err"
              grep -q 'compileSuffix steps=1 seeded=true' "$TMPDIR/rebuild.err"

              rm "$TMPDIR/output.js"
              "$out/bin/proof-of-compile" build "$TMPDIR/project/Main.bend" \
                --output "$TMPDIR/output.js" --target js \
                | grep -q 'restored artifact from cache'
              bun "$TMPDIR/output.js" | grep -q 'proof-of-compile smoke test'
              "$out/bin/proof-of-compile" cache verify | grep -q '"quarantined":0'

              runHook postInstallCheck
            '';

            meta = {
              description = "Content-addressed partial compiler for Bend 2";
              license = nixpkgs.lib.licenses.asl20;
              mainProgram = "proof-of-compile";
              platforms = nixpkgs.lib.platforms.unix;
            };
          };
        in
        {
          inherit bend;
          bend-hashes = bendHashes;
          proof-of-compile = proofOfCompile;
          default = proofOfCompile;
        }
      );

      apps = forEachSystem (
        system:
        let
          package = self.packages.${system}.proof-of-compile;
        in
        {
          proof-of-compile = {
            type = "app";
            program = "${package}/bin/proof-of-compile";
          };
          default = self.apps.${system}.proof-of-compile;
        }
      );

      checks = forEachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          bend = self.packages.${system}.bend;
          bendHashes = self.packages.${system}.bend-hashes;
        in
        {
          bend-categories = bend-categories.checks.${system}.bend-categories;

          infrastructure =
            pkgs.runCommand "bend-proof-of-compile-infrastructure-check"
              {
                nativeBuildInputs = [
                  bend
                  pkgs.bun
                ];
                BEND2_SRC = "${bend}/share/bend/bend2";
                BEND_CATEGORIES_SRC = bend-categories.outPath;
                BEND_HASHES_SRC = "${bendHashes}/share/bend/hashes";
              }
              ''
                ${checkScript}
                touch "$out"
              '';
        }
      );

      devShells = forEachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          bend = self.packages.${system}.bend;
          bendHashes = self.packages.${system}.bend-hashes;
        in
        {
          default = devenv.lib.mkShell {
            inherit inputs pkgs;
            modules = [
              {
                packages = [
                  bend
                  bendHashes
                  pkgs.bun
                  pkgs.clang
                  pkgs.nixfmt
                ];

                env = {
                  BEND2_SRC = "${bend}/share/bend/bend2";
                  BEND_CATEGORIES_SRC = bend-categories.outPath;
                  BEND_HASHES_SRC = "${bendHashes}/share/bend/hashes";
                };

                scripts.check.exec = checkScript;

                enterTest = ''
                  check
                '';
              }
            ];
          };
        }
      );

      formatter = forEachSystem (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
