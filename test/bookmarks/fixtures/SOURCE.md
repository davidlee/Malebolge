# Bookmark fixtures: provenance

## `scratchpad.jsonlz4` (857 bytes)

A Firefox bookmark backup copied unchanged from the operator's "scratchpad"
profile (`bookmarkbackups/bookmarks-2026-03-25_10_….jsonlz4`), committed by
operator ruling (SL-008 notes, 2026-10-29). It holds Mozilla's defaults only:
four default places under "Mozilla Firefox" and empty roots. Its per-profile
values are five random guids and the profile's creation time.

sha256 `93df30af0336f07c4e77931389738a21551fecc7c1851733b74333e9ab67ef03`

## `scratchpad.json` (2518 bytes)

The same backup decoded once by an independent decoder (python `lz4.block`),
the expected output for `decodeMozLz4`. Produced on the host, in the directory
holding `scratchpad.jsonlz4`, by:

```sh
nix shell --impure --expr '(import (builtins.getFlake "nixpkgs") {}).python3.withPackages (p: [p.lz4])' -c python3 -I -c 'import lz4.block; b=open("scratchpad.jsonlz4","rb").read(); assert b[:8]==b"mozLz40\0"; open("scratchpad.json","wb").write(lz4.block.decompress(b[8:]))'
```

sha256 `505c970bc53f4187b2c958a4b7084d07074d431282c315aba893596417c255f6`
