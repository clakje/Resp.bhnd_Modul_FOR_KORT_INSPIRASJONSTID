/**
 * lag-rise-zip.js — pakker spilleren som zip for Articulate Rise (kodeblokk).
 *
 * Rise krever at index.html ligger i roten av zip-filen, ikke i en undermappe.
 * Bare filene spilleren trenger i nettleseren tas med.
 *
 *   node lag-rise-zip.js                       (skriver for-kort-inspirasjonstid-player.zip)
 *   node lag-rise-zip.js annet-navn.zip
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FILES = [
    'index.html',
    'style.css',
    'player.css',
    'simulator.js',
    'renderer.js',
    'scenario-data.js',
    'scenario.json',
    'app.js'
];

// Bildene til info-dialogen (bilder/…) tas med hvis mappen finnes
const imgDir = path.resolve(__dirname, 'bilder');
if (fs.existsSync(imgDir)) {
    for (const f of fs.readdirSync(imgDir)) {
        if (/\.(png|jpe?g|gif|svg|webp)$/i.test(f)) FILES.push('bilder/' + f);
    }
}

const outName = process.argv[2] || 'for-kort-inspirasjonstid-player.zip';

// DOS-dato/-tid for zip-headerne
const now = new Date();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

const local = [];
const central = [];
let offset = 0;

for (const name of FILES) {
    const data = fs.readFileSync(path.resolve(__dirname, name));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // versjon som trengs
    lh.writeUInt16LE(0x0800, 6);      // UTF-8-filnavn
    lh.writeUInt16LE(8, 8);           // deflate
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(deflated.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, deflated);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);          // laget av
    ch.writeUInt16LE(20, 6);          // versjon som trengs
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(deflated.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);     // resten (ekstra, kommentar, disk, attributter) er 0
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + deflated.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(FILES.length, 8);
end.writeUInt16LE(FILES.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

fs.writeFileSync(path.resolve(__dirname, outName), Buffer.concat([...local, centralBuf, end]));
console.log('Skrev ' + outName + ' med ' + FILES.length + ' filer (index.html i roten).');
