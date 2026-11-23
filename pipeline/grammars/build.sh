#!/usr/bin/env bash
# Builds the grammars no maintained package ships as WASM (ARCH-9), from their pinned source, into this folder, where
# the result is committed: a binary we built from source we pinned, rather than one a third party built. Rerun it when
# a pin moves, and commit the new file with its sha256 below.
#
#   bash packages/reviewer/pipeline/grammars/build.sh
#
# Needs Docker (or emcc on the PATH): the tree-sitter CLI compiles with emscripten's image when emcc is absent.
#
# tree-sitter-swift@0.7.1 -> tree-sitter-swift.wasm
#   sha256 3df761e7f8e7065ba0d535895495b9aee19001e23fd44060269fc71f31e09dfb (built 2026-11-23, tree-sitter-cli 0.25.10)
#   The build warns that `1UL << FAKE_TRY_BANG` overflows (token 32 in a 32-bit long). Upstream's: the mask is read
#   with a 32-bit `1 << suppressor` on every platform, so native builds share it, and `try!` parses either way.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

build() {
  local package="$1" version="$2"
  (cd "$scratch" && npm pack --silent "$package@$version" >/dev/null && mkdir "$package" && tar -xzf "$package-$version.tgz" -C "$package" --strip-components 1)
  (cd "$scratch/$package" && npx -y tree-sitter-cli@0.25.10 build --wasm -o "$here/$package.wasm" .)
  cp "$scratch/$package/LICENSE" "$here/$package.LICENSE"
  shasum -a 256 "$here/$package.wasm"
}

build tree-sitter-swift 0.7.1
