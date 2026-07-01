# Door Tracker COM Bridge

Proof-of-concept Electron desktop app for testing a NETUM NT-1228BL barcode/QR
scanner over a Windows COM/serial port. Lists available ports, connects at a
chosen baud rate, and shows each completed scan (terminated by CR, LF, or
CRLF) in a live log with timestamp, port, and value.

## Run in development

```bash
npm install
npm start
```

This launches the app via Electron directly from source — use this while
making changes to the COM port logic or UI.

## Build the Windows version

```bash
npm run dist:win
```

This produces both a portable `.exe` and an NSIS setup installer `.exe` for
Windows x64. Other scripts available:

- `npm run pack` — unpacked local build for the current platform, useful for
  a quick sanity check without producing installers.
- `npm run dist` — build for whatever platform electron-builder defaults to
  on the current OS.
- `npm run dist:win` — Windows portable `.exe` + NSIS installer `.exe`
  (works even when run from macOS or Linux — electron-builder downloads its
  own bundled Wine/NSIS toolchain automatically).

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
warning.** This is expected for an unsigned proof-of-concept — click **More
info → Run anyway** to proceed. Code signing is intentionally out of scope
for this stage.

## Which build to test first

Start with the **portable `.exe`** — no installation, no admin prompt, just
run it directly. It's the fastest way to confirm the scanner and COM port
logic work end-to-end on a given Windows machine. Once that's confirmed, the
NSIS installer can be used for a more permanent setup.
