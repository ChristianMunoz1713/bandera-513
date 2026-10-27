// Genera los íconos PNG de la app sin dependencias: node crear-iconos.js
const fs = require('fs'), zlib = require('zlib'), path = require('path');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(tipo, datos) {
  const len = Buffer.alloc(4); len.writeUInt32BE(datos.length);
  const td = Buffer.concat([Buffer.from(tipo), datos]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const filas = [];
  for (let y = 0; y < size; y++) {
    const fila = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) fila.set(pixel(x / size, y / size), 1 + x * 4);
    filas.push(fila);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(filas))), chunk('IEND', Buffer.alloc(0))]);
}

const FONDO = [15, 42, 92, 255], ASTA = [240, 244, 250, 255], BANDERA = [47, 124, 246, 255], BORDE = [255, 255, 255, 255];
// Diseño en coordenadas 0..1; "m" encoge el dibujo para la zona segura del ícono maskable.
function dibujo(m, redondo) {
  return (x, y) => {
    if (redondo) {
      const r = 0.2, cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return [0, 0, 0, 0];
    }
    const u = 0.5 + (x - 0.5) / m, v = 0.5 + (y - 0.5) / m;
    if (u > 0.27 && u < 0.33 && v > 0.16 && v < 0.86) return ASTA;
    if ((u - 0.3) ** 2 + (v - 0.86) ** 2 < 0.004) return ASTA;
    // Bandera ondulada
    const onda = 0.03 * Math.sin((u - 0.33) * 14);
    const arriba = 0.18 + onda, abajo = 0.52 + onda;
    if (u >= 0.33 && u < 0.8 && v > arriba && v < abajo) {
      return (v - arriba < 0.025 || abajo - v < 0.025 || u > 0.775) ? BORDE : BANDERA;
    }
    return FONDO;
  };
}
const dir = path.join(__dirname, 'icons');
fs.writeFileSync(path.join(dir, 'icon-192.png'), png(192, dibujo(1, true)));
fs.writeFileSync(path.join(dir, 'icon-512.png'), png(512, dibujo(1, true)));
fs.writeFileSync(path.join(dir, 'icon-maskable-512.png'), png(512, dibujo(0.72, false)));
console.log('Íconos creados en', dir);
