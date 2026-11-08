# Bend dependencies as Nix derivations, composed with symlinkJoin
# (SPEC-persistent-artifacts.md, "Nix composition"; D7, D9).
#
# A store is poc's content-addressed object store. A chain is one derivation
# per region of a load order: each checks a synthetic entry importing the hub
# modules of every region up to and including its own, reads the regions
# before it as read-only layers (POC_STORE_PATH), and writes the objects its
# region adds to its output (POC_STORE). A build against the joined store
# resumes from the longest prefix its entry's load order shares with the
# chain. Reuse is along load-order prefixes and per package pin: a module's
# key names its real path under the kit and its hub namespace, so a changed
# package re-checks its region and the regions after it, and nothing before.
{
  lib,
  pkgs,
  poc,
}:
let
  layerPath = layers: lib.concatStringsSep ":" (map (layer: "${layer}") layers);
  # poc's signer needs a private, writable configuration directory per build.
  environment = ''
    export HOME="$TMPDIR/home" XDG_CONFIG_HOME="$TMPDIR/config"
    mkdir -p "$HOME" "$XDG_CONFIG_HOME"
  '';
in
rec {
  # One read-only layer from several stores.
  store =
    layers:
    pkgs.symlinkJoin {
      name = "bend-store";
      paths = layers;
    };

  # The chain of a kit's modules in load order. `regions` is a list of lists of
  # hub import paths ("0x<pkg>/Path.bend"), in the order the application's
  # loader reaches them (`poc plan ENTRY`, the namespace column with ".bend");
  # the derivation of region k seals the states after every module of regions
  # 0..k. `layers` are stores read before the chain's own. Returns the list of
  # region derivations, in order.
  chain =
    {
      name,
      kit,
      regions,
      layers ? [ ],
    }:
    let
      go =
        done: previous: remaining:
        if remaining == [ ] then
          [ ]
        else
          let
            modules = done ++ lib.head remaining;
            index = lib.length previous;
            region =
              pkgs.runCommand "${name}-region-${toString index}"
                {
                  nativeBuildInputs = [ poc ];
                  passAsFile = [ "entry" ];
                  entry = "import Base\n" + lib.concatImapStrings (i: m: "import ${m} as M${toString i}\n") modules;
                }
                ''
                  ${environment}
                  export BEND_LIB=${kit} POC_STORE="$out" POC_STORE_PATH="${layerPath (layers ++ previous)}"
                  mkdir -p "$out" "$TMPDIR/region"
                  cp "$entryPath" "$TMPDIR/region/region.bend"
                  # A region seals states; the verdict belongs to an entry, so a
                  # dependency relying on @unsafe is sealed all the same.
                  poc check --allow-unsafe "$TMPDIR/region/region.bend" > "$TMPDIR/check.out"
                  # The output holds objects only: retention is the reader's.
                  rm -rf "$out/roots"
                '';
          in
          [ region ] ++ go modules (previous ++ [ region ]) (lib.tail remaining);
    in
    go [ ] [ ] regions;

  # The artifact of `entry` (a path inside `src`) for `target`, built against
  # `layers`: $out/artifact.<target>, with poc's debug trace in $out/trace.err.
  # The build's own states go to a scratch store and are not kept.
  build =
    {
      name,
      src,
      entry,
      layers ? [ ],
      kit ? null,
      target ? "js",
    }:
    pkgs.runCommand "${name}-${target}" { nativeBuildInputs = [ poc ]; } ''
      ${environment}
      ${lib.optionalString (kit != null) ''export BEND_LIB=${kit}''}
      export POC_STORE="$TMPDIR/store" POC_STORE_PATH="${layerPath layers}" POC_DEBUG=1
      mkdir -p "$out"
      cd ${src}
      poc build ${lib.escapeShellArg entry} --target ${target} --output "$out/artifact.${target}" 2> "$out/trace.err"
    '';
}
