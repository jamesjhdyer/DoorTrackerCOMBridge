# Delivery Photos

An entirely local service: an iPad on the workshop Wi-Fi scans a delivery
note's Data Matrix code, takes photographs, and this PC files them straight
onto the company network drive. No cloud storage, no website involved in the
photo transfer at all.

```
Delivery note (Data Matrix: "5698-DELIV")
        |  iPad camera reads it directly - no URL, no domain encoded
        v
iPad Safari - the Delivery Photos web page, served by THIS program
        |  local Wi-Fi, HTTPS (see "Local HTTPS" below)
        v
This process's local HTTPS server (http-server.js)
        |  forked worker process, hard time limit (worker.js/worker-runner.js)
        v
Company network drive - the ONLY permanent copy
```

Runs as a **separate forked process** (`worker-entry.js`), supervised by
`../main.js`: a crash or a hung network drive here can never stall a COM
port read or a print job, and the reverse is equally true. If it crashes on
its own, the supervisor restarts it after a short pause.

## Why a local certificate authority

`getUserMedia` (the camera) only works in a secure context - a plain
`http://192.168.x.x` address does not qualify, on any modern browser,
iPadOS Safari included. So this program is its own tiny certificate
authority (`certs.js`): it creates one root CA, once, and signs a leaf
certificate for the configured local hostname. The iPad only ever has to
trust the CA once - open the address shown in the app, Safari offers to
install the one certificate profile it needs
(`buildTrustProfileMobileConfig`), then a single "Full Trust" toggle in
Settings. Every visit after that is a genuine, un-scary HTTPS connection.
Nothing here is a publicly trusted certificate, and nothing here ever
reaches the internet.

## Why a bundled mDNS responder

Windows does not broadcast mDNS (`.local` name) resolution on its own; this
program carries a small responder (`mdns.js`, via `bonjour-service`) so nothing
else has to be installed on the PC. iPadOS resolves `.local` names natively,
so the iPad needs nothing extra either.

## Data Matrix scanning

Safari on iOS has no `BarcodeDetector` API at all. Scanning
(`vendor/zxing/`, wired up in `delivery-photos-web/scanner.js`) uses
`zxing-wasm` (a WebAssembly build of the real zxing-cpp engine), vendored
locally rather than loaded from a CDN - this must keep working with no
internet at all. It decodes one still frame at a time (grabbed from the
live video via canvas, a few times a second) rather than the video stream
continuously, and stops entirely once a valid code has been found.

## Saving a photograph

`PUT /api/photos/<reference>/<uuid>` (raw JPEG body, `X-Photo-Sha256`
header): validated (`reference.js`, `safe-path.js`), checksum-verified,
spooled locally, then handed to `archive.js` - which runs inside the SAME
kind of forked, hard-timeout worker process the real archive engine has
always used: write to `<root>\.incoming\<uuid>.part`, flush, rename into
`<root>\<REFERENCE>\photo-NNN.jpg` (never overwriting an existing file,
adopting its own file after a crash instead of duplicating it), then READ
IT BACK and check its size and SHA-256 before the upload is ever reported
successful to the iPad. `reference.js` is the exact same file loaded by
both the server and the iPad page (see `http-server.js`'s dedicated route
for it) - there is exactly one copy of the delivery-code grammar, never two
that could quietly drift apart.

## Layout

| Path | Purpose |
|---|---|
| `worker-entry.js` | The forked process's entry point - reads settings, starts everything below, talks to `../main.js` over IPC |
| `config.js` | Settings: local hostname, port, archive folder, auto-start |
| `certs.js` | The local certificate authority and the iPad's one-time trust profile |
| `mdns.js` | Advertises the local hostname |
| `http-server.js` | The local HTTPS server: the iPad page, the upload API, the plain-HTTP trust-profile bootstrap |
| `reference.js` | The delivery-code grammar - shared verbatim by the server and the iPad page |
| `archive.js` / `worker.js` / `worker-runner.js` | Files one photograph onto the drive and reads it back to verify, inside a forked, hard-timeout worker |
| `storage-test.js` | The "Test Network Storage" button's real write-verify-cleanup check |
| `safe-path.js` | The only code that decides what may become a file path |
| `fs-ops.js` | The only code that creates/renames/deletes: temp file, flush, rename, never overwrite, read-back + SHA-256 |
| `lock.js` / `status.js` / `logger.js` | Single-instance lock, status relayed to the UI, redacted daily log files |
| `jpeg-fixture.js` | Generates valid dummy JPEGs for the storage test, marked "NOT A REAL PHOTOGRAPH" |
| `../../delivery-photos-web/` | The static iPad-facing page: camera, scanning, thumbnails, upload/retry |

## Not yet run on a real iPad or a real Windows PC

Exercised as far as this can be from a Mac: real forked worker processes,
a real generated certificate genuinely TLS-handshaked (and, separately,
genuinely refused when not trusted), a real local HTTPS server handling
real uploads end-to-end onto a real temp folder, a real UDP mDNS
round-trip, and a real headless-Chrome check (fake camera device) proving
the camera-open → WASM-load → decode pipeline runs without error. Camera
image quality, the Data Matrix on a real printed delivery note, and the
one-time certificate-trust flow on a real iPad have not been - see the main
README's testing sequence.
