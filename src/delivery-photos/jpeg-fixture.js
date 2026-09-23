'use strict';

// Dummy photographs for the storage test. NEVER real customer photographs.
//
// Each dummy is a genuine, decodable JPEG: a tiny real image (a 16x16 solid
// colour, 269 bytes, no EXIF and no GPS) with extra JPEG "comment" segments
// (marker FFFE) inserted after the start-of-image marker to reach a realistic
// size. Comment segments are ignored by every decoder, and the random payload
// is incompressible - so the bytes cross the network the way a real photograph
// would, and every file is unique (which makes wrong-file mix-ups visible).

const { randomBytes } = require('node:crypto');

const BASE_JPEG = Buffer.from(
  '/9j/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCfgKIH/9k=',
  'base64'
);

const MAX_COM_PAYLOAD = 65533; // a segment's 2-byte length field counts itself

function commentSegment(payload) {
  if (payload.length > MAX_COM_PAYLOAD) throw new RangeError('JPEG comment payload too large');
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = 0xfe;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

// Returns a valid JPEG of roughly `targetBytes` (within 3 bytes below it).
function makeDummyJpeg({ label, targetBytes }) {
  const soi = BASE_JPEG.subarray(0, 2);
  const rest = BASE_JPEG.subarray(2);
  const segments = [commentSegment(Buffer.from(`photo-bridge-storage-test ${label} - NOT A REAL PHOTOGRAPH`, 'ascii'))];

  let size = BASE_JPEG.length + segments[0].length;
  while (targetBytes - size >= 4) {
    const payloadLength = Math.min(MAX_COM_PAYLOAD, targetBytes - size - 4);
    const segment = commentSegment(randomBytes(payloadLength));
    segments.push(segment);
    size += segment.length;
  }
  return Buffer.concat([soi, ...segments, rest]);
}

// Structural check that walks the segments by their declared lengths: starts
// with SOI, contains a frame header (SOF), every segment length is consistent,
// and the file ends with EOI. It cannot decode pixels - that is checked
// separately during development - but it does catch truncation and corruption.
function inspectJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return { ok: false, reason: 'missing start-of-image marker' };
  if (buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) return { ok: false, reason: 'missing end-of-image marker' };

  let offset = 2;
  let sawFrameHeader = false;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return { ok: false, reason: `expected a marker at byte ${offset}` };
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];

    if (marker === 0xd9) return { ok: sawFrameHeader && offset === buffer.length, reason: 'end-of-image reached' };
    if (marker === 0xda) return { ok: sawFrameHeader, reason: sawFrameHeader ? 'scan data reached' : 'scan data without a frame header' };
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // markers without a length

    if (offset + 2 > buffer.length) return { ok: false, reason: 'truncated segment header' };
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return { ok: false, reason: `bad segment length at byte ${offset}` };
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) sawFrameHeader = true;
    offset += length;
  }
  return { ok: false, reason: 'ran off the end of the file' };
}

module.exports = { BASE_JPEG, makeDummyJpeg, inspectJpeg };
