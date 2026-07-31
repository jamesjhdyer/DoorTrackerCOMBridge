// Windows-only printer access: enumerate installed printers, check whether
// a specific one exists/is online, and submit raw bytes to a named printer
// queue. Every exported function checks process.platform itself and
// returns a clear "not supported here" result on any other platform —
// nothing in this file ever throws just because it's running on macOS
// during development; it simply reports that it can't do anything real.
//
// No native Node dependency is used for any of this — each operation
// shells out to Windows' own PowerShell (present on every Windows install)
// via a small script written to a temp file and run once. This keeps the
// whole app installable/buildable with a single `npm install` on any
// platform (no node-gyp/native-module concerns for this feature), at the
// cost of one short-lived child process per call — entirely acceptable
// given how infrequently these operations run (once per print, plus
// occasional manual list/status checks).
//
// Raw submission specifically uses the long-standing Win32 "RawPrinterHelper"
// P/Invoke pattern (OpenPrinter/StartDocPrinter/WritePrinter/EndDocPrinter
// with datatype "RAW") — this bypasses the printer driver's own rendering
// entirely, which is what lets ZPL text reach the GK420D unmodified and
// with no print dialog, regardless of which Windows driver is associated
// with the queue.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const IS_WINDOWS = process.platform === 'win32';
const POWERSHELL_TIMEOUT_MS = 15000;

function runPowerShellScript(scriptContent, args = []) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(os.tmpdir(), `combridge-ps-${randomUUID()}.ps1`);

    try {
      fs.writeFileSync(scriptPath, scriptContent, 'utf8');
    } catch (err) {
      reject(new Error(`Could not write temporary PowerShell script: ${err.message}`));
      return;
    }

    const cleanup = () => fs.unlink(scriptPath, () => {});

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        cleanup();
        if (err) {
          const detail = (stderr && stderr.trim()) || err.message;
          reject(new Error(detail));
          return;
        }
        resolve((stdout || '').trim());
      }
    );
  });
}

const LIST_PRINTERS_SCRIPT = `
param()
$ErrorActionPreference = 'Stop'
$printers = Get-CimInstance -ClassName Win32_Printer | Select-Object Name, Default, WorkOffline
$printers | ConvertTo-Json -Compress
`;

// Returns { supported: false } on any non-Windows platform. On Windows,
// { supported: true, printers: [{ name, isDefault, isOffline }, ...] }.
async function listPrinters() {
  if (!IS_WINDOWS) {
    return { supported: false, printers: [] };
  }

  const stdout = await runPowerShellScript(LIST_PRINTERS_SCRIPT);
  const parsed = stdout ? JSON.parse(stdout) : [];
  // ConvertTo-Json returns a bare object (not a 1-element array) when
  // there's exactly one result — normalize that here so callers never see
  // the difference.
  const list = Array.isArray(parsed) ? parsed : [parsed];

  return {
    supported: true,
    printers: list.filter(Boolean).map((p) => ({
      name: p.Name,
      isDefault: !!p.Default,
      isOffline: !!p.WorkOffline
    }))
  };
}

const GET_STATUS_SCRIPT = `
param([Parameter(Mandatory=$true)][string]$PrinterName)
$ErrorActionPreference = 'Stop'
$escaped = $PrinterName.Replace("'", "''")
$printer = Get-CimInstance -ClassName Win32_Printer -Filter "Name='$escaped'"
if ($null -eq $printer) {
  @{ found = $false } | ConvertTo-Json -Compress
} else {
  @{ found = $true; isOffline = [bool]$printer.WorkOffline } | ConvertTo-Json -Compress
}
`;

// Returns { supported: false, found: false, offline: false } off-Windows.
// On Windows, { supported: true, found, offline }.
async function getPrinterStatus(printerName) {
  if (!IS_WINDOWS) {
    return { supported: false, found: false, offline: false };
  }
  if (!printerName) {
    return { supported: true, found: false, offline: false };
  }

  const stdout = await runPowerShellScript(GET_STATUS_SCRIPT, ['-PrinterName', printerName]);
  const parsed = stdout ? JSON.parse(stdout) : { found: false };
  return { supported: true, found: !!parsed.found, offline: !!parsed.isOffline };
}

// Canonical Win32 "send raw bytes to a printer queue" pattern (OpenPrinter/
// StartDocPrinter/StartPagePrinter/WritePrinter/EndPagePrinter/EndDocPrinter
// with datatype "RAW") — this is the long-established technique real
// label/receipt-printing software uses on Windows to bypass driver
// rendering entirely, ported here to a PowerShell inline C# type via
// Add-Type rather than a compiled native Node addon.
const SEND_RAW_SCRIPT = `
param(
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [Parameter(Mandatory=$true)][string]$FilePath
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

    [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

    public static void SendBytesToPrinter(string printerName, byte[] bytes)
    {
        IntPtr hPrinter;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "Door Tracker Delivery Label";
        di.pDataType = "RAW";
        bool ok;

        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter failed");
        }
        try
        {
            if (!StartDocPrinter(hPrinter, 1, di))
            {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartDocPrinter failed");
            }
            try
            {
                if (!StartPagePrinter(hPrinter))
                {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartPagePrinter failed");
                }
                IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(bytes.Length);
                try
                {
                    Marshal.Copy(bytes, 0, pUnmanagedBytes, bytes.Length);
                    int written;
                    ok = WritePrinter(hPrinter, pUnmanagedBytes, bytes.Length, out written);
                    if (!ok || written != bytes.Length)
                    {
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "WritePrinter failed or wrote a short buffer");
                    }
                }
                finally
                {
                    Marshal.FreeCoTaskMem(pUnmanagedBytes);
                    EndPagePrinter(hPrinter);
                }
            }
            finally
            {
                EndDocPrinter(hPrinter);
            }
        }
        finally
        {
            ClosePrinter(hPrinter);
        }
    }
}
'@

$bytes = [System.IO.File]::ReadAllBytes($FilePath)
[RawPrinterHelper]::SendBytesToPrinter($PrinterName, $bytes)
Write-Output "OK"
`;

// Submits raw bytes (already-generated ZPL text, encoded as a Buffer) to a
// named Windows printer queue, bypassing the driver's own rendering.
// Resolves once Windows has accepted the submission (WritePrinter
// succeeded) — see printer-service.js for exactly what that does and does
// not prove about physical output.
async function sendRawData(printerName, dataBuffer) {
  if (!IS_WINDOWS) {
    throw new Error('Raw printer submission is only implemented on Windows.');
  }

  const tempDataPath = path.join(os.tmpdir(), `combridge-print-${randomUUID()}.zpl`);
  fs.writeFileSync(tempDataPath, dataBuffer);

  try {
    await runPowerShellScript(SEND_RAW_SCRIPT, ['-PrinterName', printerName, '-FilePath', tempDataPath]);
  } finally {
    fs.unlink(tempDataPath, () => {});
  }
}

module.exports = { listPrinters, getPrinterStatus, sendRawData };
