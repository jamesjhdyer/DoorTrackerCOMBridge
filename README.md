# Door Tracker COM Bridge

The one Windows desktop app for the workshop PC:

- **Scanning** — a NETUM NT-1228BL barcode/QR scanner over a Windows COM/serial
  port. Lists available ports, connects at a chosen baud rate, and shows each
  completed scan (terminated by CR, LF, or CRLF) in a live log, sent on to the
  Door Production Tracker website.
- **Label printing** — delivery labels rendered by the website, sent here and
  printed on a Zebra GK420D via raw ZPL (bypassing the Windows print driver).
- **Delivery Photos** — an entirely local service: an iPad on the same
  workshop Wi-Fi scans a delivery note's Data Matrix or QR code, takes photographs,
  and this PC files them straight onto the company network drive. No cloud,
  no website involved in the photo transfer at all — it works even with the
  website completely unreachable. See
  [`src/delivery-photos/README.md`](src/delivery-photos/README.md) for how
  that piece works.

Scanning/printing and Delivery Photos are deliberately isolated from each
other: Delivery Photos runs as a **separate forked process**, supervised by
this app and restarted automatically if it ever crashes, so a problem with
the network drive or the local Wi-Fi server can never stall a COM port read
or a print job, and vice versa.

## Run in development

```bash
npm install
npm test    # see "Delivery Photos" below for what this exercises
npm start
```

This launches the app via Electron directly from source — use this while
making changes to the COM port, printing, or Delivery Photos logic.

## Delivery Photos

Configured from its own tab in the app (**Delivery Photos**): a local
hostname (e.g. `door-tracker.local`, advertised via mDNS — bundled in this
app, nothing extra to install), a port, and the network archive folder (a
`\\server\share\...` UNC path or a mapped drive letter such as
`S:\Delivery Photographs`). "Start Photo Service" begins listening; the
panel shows the address to open on the iPad, **Orders filed today** and the
Google Sheet sync status.

### Photo roles and how photographs are filed

Every iPad is paired as one of three **photo roles**, chosen on this PC
under **Pair a New iPad** and fixed to that iPad until it is removed (the
iPad cannot choose or change it):

| Role | Scans | Example | Files as |
|---|---|---|---|
| Delivery | the delivery note | `5698-P2-DELIV` | `001-DELIV.jpg` |
| Bench | a door or frame production label | `5698-D`, `5626-2-F` | `002-BENCH.jpg` |
| Ironmongery | an order number (scanned or typed) | `5698`, `5626-2` | `003-IRN.jpg` |

Every photograph, whatever its role, goes into ONE folder per order, named
with the base order number only - `S:\Delivery Photographs\5698\` or
`...\5626-2\` - and is numbered across the whole folder, so Delivery, Bench
and Ironmongery photos of one order sit side by side in the order taken
(`001-DELIV.jpg`, `002-BENCH.jpg`, `003-IRN.jpg`, `004-DELIV.jpg`...).
Folders from before this layout (`5698-DELIV\photo-001.jpg`) are left
exactly as they are.

Only Delivery sessions are tracked in the Google Sheet (DELIVERY_PHOTO_SCANS,
with Full/Part details from the delivery code) and counted in **Orders filed
today**. To give an iPad a different role, **Remove** it from the Paired
iPads list and pair it again with the new role.

The iPad needs its camera to work, which requires a genuine secure (HTTPS)
context — the app is its own tiny certificate authority for this, and an
iPad only ever has to trust it once (open the address shown, install the one
certificate profile Safari offers, then flip the "Full Trust" toggle in
Settings → General → About → Certificate Trust Settings). Every visit after
that is a normal, un-scary HTTPS connection.

### Away from the workshop (offline capture)

The iPad tool keeps working with no connection to this PC. Photographs taken
while the Photo Service cannot be reached are saved on the iPad (in that
site's own browser storage, IndexedDB) and sent automatically the next time
the tool is open on the workshop Wi-Fi - for all three roles. A delivery only counts as filed, and
only gets its Google Sheet row, once every photograph has been verified on
the company drive.

One-time setup, **on the workshop Wi-Fi**:

1. Open the address shown in the app in Safari and pair the iPad as usual
   (choosing its role on the PC first).
2. Share → **Add to Home Screen**, then open **Delivery Photos** from the
   Home Screen and pair it once more, with the same role (a Home Screen app has its own storage,
   separate from Safari's - use only the Home Screen app from then on).
3. On its pending screen, "Opens without the workshop PC" should say **yes**.

Pending deliveries are sent only while the tool is open and in the
foreground (iPadOS does not reliably run web apps in the background).
Photographs waiting on the iPad can be seen by anyone who can unlock it and
open the tool, so keep the iPad passcode-locked.

`npm test` runs everything for Delivery Photos too: real forked worker
processes doing real file I/O, a real generated certificate genuinely
TLS-handshaked over localhost, a real local HTTPS server handling real photo
uploads end-to-end, and a real UDP mDNS round-trip (this last one skips
cleanly rather than failing on a machine/network that does not allow
multicast — see `src/delivery-photos/mdns.test.js`). The offline tests also
drive the real iPad page in headless Google Chrome
(`src/delivery-photos/offline-browser.test.js`), skipping cleanly if Chrome is
not installed.

## Build the Windows version

```bash
npm run dist:win
```

This produces both a portable `.exe` and an NSIS setup installer `.exe` for
Windows x64, with Delivery Photos' web assets (the iPad-facing page, the
bundled barcode-scanning library) bundled unpacked alongside the app so the
local server can serve them directly. Other scripts available:

- `npm run pack` — unpacked local build for the current platform, useful for
  a quick sanity check without producing installers.
- `npm run dist` — build for whatever platform electron-builder defaults to
  on the current OS.
- `npm run dist:win` — Windows portable `.exe` + NSIS installer `.exe`
  (works even when run from macOS or Linux — electron-builder downloads its
  own bundled Wine/NSIS toolchain automatically).

The GitHub Actions build (`.github/workflows/build-windows.yml`) runs the
full test suite on a real Windows machine first — **a failing test fails the
whole build**, so a package is never published from code whose tests did not
pass — then verifies the Delivery Photos web assets really made it into the
built package, before uploading the artifact.

## Where the built files appear

Everything lands in the `dist/` folder at the project root, including:

- `Door Tracker COM Bridge <version>.exe` — portable build, no installation
  required, just double-click to run.
- `Door Tracker COM Bridge Setup <version>.exe` — NSIS installer that installs
  the app and creates shortcuts.
- `dist/win-unpacked/` — the raw unpacked app (used internally, not meant for
  distribution).

`dist/` is git-ignored and regenerated on every build.

## Unsigned app warning

This app is not code-signed. When you run either `.exe` on a Windows machine,
**Windows SmartScreen will likely show a "Windows protected your PC"
warning.** This is expected for an unsigned app — click **More info → Run
anyway** to proceed. Code signing is intentionally out of scope for this stage.

## Which build to test first

Start with the **portable `.exe`** — no installation, no admin prompt, just
run it directly. It's the fastest way to confirm the scanner, printing and
Delivery Photos all work end-to-end on a given Windows machine. Once that's
confirmed, the NSIS installer can be used for a more permanent setup.
