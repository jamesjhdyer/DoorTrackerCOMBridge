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

## Remote Admin (COM connections from another PC)

Lets the scanner connections be checked and controlled from a normal
browser on another computer on the company network (e.g. upstairs) - no
Remote Desktop, no domain membership needed. It covers the **COM
connections only**: status (connected/disconnected/error, last scan, last
error), Connect / Disconnect / Reconnect one port, Restart scanner
subsystem (every connected or failed port), Refresh ports, edit a
connection's COM port / station / baud rate, add or remove a connection,
and the recent COM Bridge log and Remote Admin audit log. It cannot send
anything to a serial port, run programs, browse files, reboot the PC, or
change Delivery Photos.

**Switching it on** (Windows app, **Remote Admin** tab, on this PC only):

1. Set an admin password (at least 8 characters - an 8-digit PIN is the
   shortest accepted). Only a salted scrypt hash is stored.
2. Tick **Allow Remote Admin from the local network**, keep port **8445**
   (or choose another) and Save.
3. On the other PC open one of the addresses shown, e.g.
   `https://<COMPUTERNAME>:8445/admin/` or `https://<laptop IP>:8445/admin/`.

Remote Admin can never change its own password, port or on/off switch -
only this Windows app can. Changing the password signs every browser out;
**Sign Out All Remote Sessions** does the same without changing it.

**Security, in brief.** It runs as its own forked process
(`src/remote-admin/admin-entry.js`), supervised like Delivery Photos, so
TLS/HTTP/sign-in never run inside the process that reads the serial ports.
That process can only ask the app to do one of a fixed list of actions
(`src/remote-admin/actions.js`), which re-validates everything with the
same settings code the Windows tabs use (`src/com-settings.js`,
`src/com-options.js`). Connections from anything but a private / link-local
/ loopback address are dropped before TLS; the Host header must name this
PC; sign-in is limited to 5 failures per address (25 overall) per 15
minutes; sessions are HttpOnly + Secure + SameSite=Strict cookies that end
after 30 idle minutes or 8 hours; every change needs a same-origin Origin
header, a JSON body, the session's CSRF token, and stays under 8 KB.
Disruptive actions (disconnecting or reconnecting a working port, changing
a COM port, removing a connection, restarting all) must be confirmed. Every
sign-in and action is written to `logs/remote-admin-YYYY-MM-DD.log` with
the client's IP and the outcome - never a password or token. An iPad's
Delivery Photos pairing token grants nothing here.

**Windows Firewall.** The app never changes the firewall. Remote Admin
needs inbound TCP on its port (default 8445) from the local network. Windows
may show its own "allow access" prompt the first time it listens: allow
**Private** networks only, never Public. Or add the rule yourself in an
elevated PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Door Tracker COM Bridge Remote Admin" -Direction Inbound -Protocol TCP -LocalPort 8445 -Action Allow -Profile Private -RemoteAddress LocalSubnet
```

A PC that is not joined to the domain never uses the Domain profile, so
this rule applies only while the laptop's network is set to **Private**.
If Windows has it as Public, the rule does not apply. Changing that is
deliberately left to you.

**Certificate warning.** Remote Admin has its own small local certificate
authority (same code as Delivery Photos, its own files). To avoid the
browser warning on the other PC, download `/admin/ca.crt` from the admin
page, check its SHA-256 fingerprint matches the one in the Remote Admin
tab, and import it into that PC's *Trusted Root Certification Authorities*
store. Otherwise expect the warning on each visit.

**Not included:** restarting the whole COM Bridge app remotely. A portable
`.exe` cannot reliably relaunch itself (it runs from a temporary extracted
copy), so it could leave the app not running with nobody downstairs to
start it again. Restart scanner subsystem covers the scanner side.

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
