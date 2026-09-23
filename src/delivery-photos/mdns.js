'use strict';

// Advertises this PC's local hostname (e.g. "door-tracker.local") on the
// workshop network via mDNS, so the iPad can find it by name without any
// extra software - iPadOS resolves ".local" names natively. Windows itself
// does not broadcast mDNS out of the box (confirmed before writing this),
// so this program carries its own small responder rather than asking anyone
// to install Apple's Bonjour separately.

const { Bonjour } = require('bonjour-service');

const SERVICE_TYPE = 'delivery-photos';

// A small utility for anyone needing the bare label (e.g. for display).
// NOT used when calling bonjour-service below - confirmed by a real mDNS
// query before writing this: its `host` option is used VERBATIM as the
// address record's own name, it does NOT append ".local" itself (despite
// most examples passing a bare label) - so the full "door-tracker.local"
// form must be passed to advertise() below, never stripped.
function stripLocalSuffix(hostname) {
  return hostname.replace(/\.local$/i, '');
}

// Starts advertising and returns a handle with stop(). Publishing a real
// service (not just the bare hostname) is what makes bonjour-service answer
// A-record queries for the host at all, and is a harmless, useful bonus in
// its own right (a future "find my Photo service on the network" tool could
// browse for `_delivery-photos._tcp.local` instead of needing to already
// know the hostname).
function advertise({ hostname, port }) {
  const bonjour = new Bonjour();
  const service = bonjour.publish({ name: 'Door Tracker Delivery Photos', type: SERVICE_TYPE, port, host: hostname });

  return {
    stop() {
      return new Promise((resolve) => {
        service.stop(() => bonjour.destroy(() => resolve()));
      });
    }
  };
}

module.exports = { advertise, SERVICE_TYPE, stripLocalSuffix };
