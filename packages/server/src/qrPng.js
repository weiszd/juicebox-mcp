/**
 * Generate a base64-encoded PNG from a QR code URL string.
 * Pure JS — no canvas or native dependencies required.
 * Works in Node.js, Cloudflare Workers, and browsers.
 */
import QRCode from 'qrcode';

// CRC32 lookup table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c;
}

function crc32(buf, start = 0, end = buf.length) {
  let crc = 0xFFFFFFFF;
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function write32(buf, offset, value) {
  buf[offset]     = (value >>> 24) & 0xFF;
  buf[offset + 1] = (value >>> 16) & 0xFF;
  buf[offset + 2] = (value >>> 8) & 0xFF;
  buf[offset + 3] = value & 0xFF;
}

function write16LE(buf, offset, value) {
  buf[offset]     = value & 0xFF;
  buf[offset + 1] = (value >>> 8) & 0xFF;
}

function pngChunk(type, data) {
  // length(4) + type(4) + data + crc(4)
  const chunk = new Uint8Array(4 + 4 + data.length + 4);
  write32(chunk, 0, data.length);
  chunk[4] = type.charCodeAt(0);
  chunk[5] = type.charCodeAt(1);
  chunk[6] = type.charCodeAt(2);
  chunk[7] = type.charCodeAt(3);
  chunk.set(data, 8);
  const crc = crc32(chunk, 4, 8 + data.length);
  write32(chunk, 8 + data.length, crc);
  return chunk;
}

function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Wrap raw data in a zlib container using stored (uncompressed) deflate blocks.
 */
function zlibStored(raw) {
  const maxBlock = 65535;
  const numBlocks = Math.ceil(raw.length / maxBlock) || 1;
  // zlib header(2) + blocks(5 bytes header each + data) + adler32(4)
  const out = new Uint8Array(2 + numBlocks * 5 + raw.length + 4);
  let p = 0;
  out[p++] = 0x78; // CMF
  out[p++] = 0x01; // FLG

  let remaining = raw.length;
  let offset = 0;
  while (remaining > 0) {
    const blockLen = Math.min(remaining, maxBlock);
    const isFinal = remaining <= maxBlock;
    out[p++] = isFinal ? 0x01 : 0x00;
    write16LE(out, p, blockLen); p += 2;
    write16LE(out, p, blockLen ^ 0xFFFF); p += 2;
    out.set(raw.subarray(offset, offset + blockLen), p);
    p += blockLen;
    offset += blockLen;
    remaining -= blockLen;
  }

  const adler = adler32(raw);
  write32(out, p, adler);
  return out;
}

/**
 * Generate a base64-encoded PNG QR code for the given text.
 * @param {string} text - The text to encode
 * @param {number} [scale=8] - Pixels per QR module
 * @returns {string} base64-encoded PNG data (no data: prefix)
 */
export function generateQRPng(text, scale = 8) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const margin = scale; // 1-module margin
  const imgSize = size * scale + margin * 2;

  // Build 1-bit indexed scanlines (color type 3, bit depth 1)
  // palette: 0=white, 1=black
  const rowBytes = Math.ceil(imgSize / 8);
  const rawScanlines = new Uint8Array(imgSize * (1 + rowBytes)); // filter byte + row data

  for (let py = 0; py < imgSize; py++) {
    const rowOffset = py * (1 + rowBytes);
    rawScanlines[rowOffset] = 0; // filter: None

    for (let px = 0; px < imgSize; px++) {
      // Map pixel to QR module
      const mx = Math.floor((px - margin) / scale);
      const my = Math.floor((py - margin) / scale);
      const isBlack = mx >= 0 && mx < size && my >= 0 && my < size && data[my * size + mx];

      if (isBlack) {
        const byteIdx = rowOffset + 1 + (px >> 3);
        rawScanlines[byteIdx] |= (0x80 >> (px & 7));
      }
    }
  }

  // IHDR
  const ihdr = new Uint8Array(13);
  write32(ihdr, 0, imgSize);  // width
  write32(ihdr, 4, imgSize);  // height
  ihdr[8] = 1;   // bit depth
  ihdr[9] = 3;   // color type: indexed
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // PLTE: white(0), black(1)
  const plte = new Uint8Array([255, 255, 255, 0, 0, 0]);

  // IDAT
  const compressed = zlibStored(rawScanlines);

  // Assemble PNG
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = pngChunk('IHDR', ihdr);
  const plteChunk = pngChunk('PLTE', plte);
  const idatChunk = pngChunk('IDAT', compressed);
  const iendChunk = pngChunk('IEND', new Uint8Array(0));

  const png = new Uint8Array(
    signature.length + ihdrChunk.length + plteChunk.length + idatChunk.length + iendChunk.length
  );
  let off = 0;
  png.set(signature, off); off += signature.length;
  png.set(ihdrChunk, off); off += ihdrChunk.length;
  png.set(plteChunk, off); off += plteChunk.length;
  png.set(idatChunk, off); off += idatChunk.length;
  png.set(iendChunk, off);

  // Base64 encode — works in both Node.js (Buffer) and Workers (btoa)
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(png).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < png.length; i++) binary += String.fromCharCode(png[i]);
  return btoa(binary);
}
