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

## The archive folder: a UNC path or a mapped drive letter

`config.js` accepts either an absolute UNC path (`\\SERVER\Share\Delivery
Photographs`) or a mapped drive letter (`S:\Delivery Photographs`) -
`safe-path.js`'s `classifyRoot()` is the only place either form is judged,
and whichever one is entered is used exactly as typed, never converted or
guessed from one to the other.

A drive letter works here specifically because the worker (`worker-entry.js`)
always runs forked from the interactive, logged-in COM Bridge app - never as
a Windows service or a scheduled task under a different account - so it sees
the same drive mappings the person who set this up sees in File Explorer,
the same way any other program they run does. That is also why a drive
letter would NOT be safe if this were ever redeployed as a background
service: a mapped drive exists only inside the Windows logon session that
created it.

Because a mapped drive can be slow to reconnect right after logging in (or
can drop out later), the archive root is probed - read-only, through the
same isolated, hard-timeout forked worker every real archive operation uses
- once at startup and then periodically while running. If it is not
reachable, the worker keeps running (the iPad still gets a clear, retryable
error rather than the app crashing) and status reports something specific,
for example "Network drive unavailable — waiting for S:"; once the drive
reconnects, the next probe picks it up automatically, no restart needed.

## Photo roles

Each paired iPad has ONE role - `delivery`, `bench` or `ironmongery` - chosen
on the PC when its pairing code is generated (`auth.js`) and stored with the
hash of its token in `state/paired-devices.json`. The server only ever takes
the role from `pairing.verify(token)`; the iPad never sends one that is
trusted. `photo-roles.js` (shared verbatim by server and iPad, like
`reference.js`) holds the one grammar per role:

| Role | Accepts | Base order | Suffix |
|---|---|---|---|
| delivery | `reference.js` unchanged: `5698-DELIV`, `5698-P-DELIV`, `5698-P2-DELIV`, `5626-2-P3-DELIV` | the order number | `DELIV` |
| bench | `<ORDER>-D-<unit>` / `<ORDER>-F-<unit>`, unit 2-4 digits, not zero | everything before `-D-`/`-F-` | `BENCH` |
| ironmongery | `<ORDER>` alone, e.g. `5698`, `5626-2` | itself | `IRN` |

`<ORDER>` is digit groups joined by single hyphens, at most 20 characters.
The grammars are disjoint, so a code scanned as one role can never be filed
as another. Device records from before roles existed have no role and are
treated as Delivery.

## Saving a photograph

`PUT /api/photos/<scanned code>/<uuid>` (raw JPEG body, `X-Photo-Sha256`
header, optional `X-Photo-Role` naming the role the photo was TAKEN as -
compared, never used): the token gives the role; the code is parsed with
that role's grammar to get the base order; then checksum-verified, spooled
locally, and handed to `archive.js` as `{ baseOrder, photoRole, photoId,
bytes, sha256 }` - which runs inside the SAME kind of forked, hard-timeout
worker process the real archive engine has always used: create or reuse
`<root>\<baseOrder>\`, write to `<root>\.incoming\<uuid>.part`, flush,
rename into `<root>\<baseOrder>\<NNN>-<SUFFIX>.jpg`, then READ IT BACK and
check its size and SHA-256 before the upload is ever reported successful to
the iPad.

Numbering: `NNN` is one more than the highest number claimed by any
`<digits>-<letters>.jpg` file already in the order folder (any role, any
letter case), at least three digits - never a count of files, never a
reused gap, never an overwrite (an existing name is skipped). Saves into the
same order folder are serialised by a per-order lock in the server
(`concurrency.js`'s `KeyedMutex`), so two iPads can never pick the same
number. A retry of a photo already filed (same role suffix, size and
SHA-256) adopts the existing file instead - no duplicate, no number used.

`POST /api/photo-sessions/complete { sessionId, code, photosSaved }` closes
a session for any role; only Delivery creates a DELIVERY_PHOTO_SCANS
tracking event and an "Orders filed today" entry (see `SESSION_TRACKERS` in
`http-server.js` - the place to add Bench/Ironmongery tracking later). The
original `POST /api/delivery-sessions/complete` stays for iPads still running
the previous page, and only accepts Delivery tokens.

## Layout

| Path | Purpose |
|---|---|
| `worker-entry.js` | The forked process's entry point - reads settings, starts everything below, talks to `../main.js` over IPC |
| `config.js` | Settings: local hostname, port, archive folder, auto-start |
| `certs.js` | The local certificate authority and the iPad's one-time trust profile |
| `mdns.js` | Advertises the local hostname |
| `http-server.js` | The local HTTPS server: the iPad page, the upload API, the plain-HTTP trust-profile bootstrap |
| `reference.js` | The delivery-code grammar - shared verbatim by the server and the iPad page |
| `photo-roles.js` | The three photo roles and their code grammars - shared verbatim by the server and the iPad page |
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
