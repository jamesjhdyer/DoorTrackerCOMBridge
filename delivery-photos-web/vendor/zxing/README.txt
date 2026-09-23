Vendored from the "zxing-wasm" npm package (reader-only IIFE build), version 3.1.4.
  zxing-reader.js   <- node_modules/zxing-wasm/dist/iife/reader/index.js
  zxing_reader.wasm <- node_modules/zxing-wasm/dist/reader/zxing_reader.wasm

Vendored (copied) rather than loaded from a CDN on purpose: this program must
keep working with the internet completely unreachable. scanner.js forces
locateFile() to always resolve next to this script, never jsDelivr (the
library's own default).

To update: `npm install zxing-wasm@<new version>` in the repo root, then copy
the same two files again from the same node_modules paths.
