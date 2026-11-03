'use strict';

// Who may even open a connection to Remote Admin, and which names it may be
// addressed by.
//
//   - isPrivateAddress(): the TCP peer must be on a private (RFC 1918 /
//     IPv6 unique-local), link-local or loopback address. Anything else is
//     disconnected before TLS even starts - so even if a firewall rule or a
//     router were ever misconfigured, a connection from the internet would
//     still be refused here. This is a second line of defence, not the only
//     one: Windows Firewall (Private/Domain profiles only) is the first, and
//     the admin password is what actually grants access.
//   - hostAllowed(): the Host header must name THIS PC (its computer name,
//     computer-name.local, one of its own addresses, or localhost). Defeats
//     DNS-rebinding, where a web page on some other site points its own
//     domain name at this PC's address.

const os = require('node:os');
const net = require('node:net');

function normalizeIp(raw) {
  const text = String(raw || '').toLowerCase();
  const unzoned = text.split('%')[0];
  return unzoned.startsWith('::ffff:') && net.isIPv4(unzoned.slice(7)) ? unzoned.slice(7) : unzoned;
}

function isPrivateAddress(raw) {
  const ip = normalizeIp(raw);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (net.isIPv6(ip)) {
    if (ip === '::1') return true;
    const first = parseInt(ip.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 /* fc00::/7 unique-local */ || (first & 0xffc0) === 0xfe80 /* fe80::/10 link-local */;
  }
  return false;
}

function computerName() {
  return String(os.hostname() || '').toLowerCase().split('.')[0];
}

// os.hostname() when it is a full DNS name (e.g. pc.office.lan on a Mac or a
// PC with a DNS suffix), otherwise ''.
function fullHostName() {
  const full = String(os.hostname() || '').toLowerCase();
  return full.includes('.') && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(full) ? full : '';
}

// This PC's own non-loopback private IPv4 addresses, e.g. ['192.168.1.40'].
function localIpv4Addresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateAddress(entry.address)) out.push(entry.address);
    }
  }
  return [...new Set(out)].sort();
}

function localIpv6Addresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv6' && !entry.internal && isPrivateAddress(entry.address)) out.push(normalizeIp(entry.address));
    }
  }
  return out;
}

// The addresses to show the operator: computer name first, then each LAN IP.
function adminUrls(port) {
  const name = String(os.hostname() || '').split('.')[0] || 'this-pc';
  return [`https://${name}:${port}/admin/`, ...localIpv4Addresses().map((ip) => `https://${ip}:${port}/admin/`)];
}

function allowedHostNames() {
  const names = new Set(['localhost', '127.0.0.1', '::1', ...localIpv4Addresses(), ...localIpv6Addresses()]);
  const name = computerName();
  if (name) {
    names.add(name);
    names.add(`${name}.local`);
  }
  const full = fullHostName();
  if (full) names.add(full);
  return names;
}

// Splits a Host header into { name, port } - port is null when absent.
function parseHostHeader(header) {
  const text = String(header || '').trim().toLowerCase();
  if (!text || text.length > 255) return null;
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(text);
  if (v6) return { name: v6[1], port: v6[2] ? Number(v6[2]) : null };
  const plain = /^([a-z0-9.-]+?)\.?(?::(\d{1,5}))?$/.exec(text);
  if (!plain) return null;
  return { name: plain[1], port: plain[2] ? Number(plain[2]) : null };
}

// `names` defaults to allowedHostNames(); a name may also be the computer
// name followed by the network's own DNS suffix (computer.office.lan), as a
// company DHCP/DNS server commonly hands out even to a PC outside the domain.
function hostAllowed(header, port, names = allowedHostNames()) {
  const parsed = parseHostHeader(header);
  if (!parsed) return false;
  if (parsed.port !== null && parsed.port !== port) return false;
  if (names.has(parsed.name)) return true;
  const name = computerName();
  return Boolean(name) && parsed.name.startsWith(`${name}.`) && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(parsed.name);
}

module.exports = { normalizeIp, isPrivateAddress, computerName, fullHostName, localIpv4Addresses, adminUrls, allowedHostNames, parseHostHeader, hostAllowed };
