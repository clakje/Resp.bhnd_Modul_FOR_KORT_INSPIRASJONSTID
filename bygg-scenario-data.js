/**
 * bygg-scenario-data.js — lager scenario-data.js fra scenario.json.
 *
 * Nettleseren blokkerer fetch() når siden åpnes rett fra disk (file://).
 * Ved å bake scenariet inn i en .js-fil virker spilleren også med dobbeltklikk.
 *
 *   node bygg-scenario-data.js                  (leser scenario.json)
 *   node bygg-scenario-data.js mitt-scenario.json
 */
const fs = require('fs');
const path = require('path');

const src = process.argv[2] || 'scenario.json';
const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, src), 'utf8'));

const out = '/**\n'
    + ' * scenario-data.js — AUTOGENERERT av bygg-scenario-data.js. Ikke rediger for hånd.\n'
    + ' * Kilde: ' + src + '\n'
    + ' *\n'
    + ' * Denne filen har forrang: finnes den, bruker spilleren den i stedet for å\n'
    + ' * hente scenario.json. Kjør skriptet på nytt etter endringer i scenario.json,\n'
    + ' * eller slett filen for å la spilleren hente JSON-en over nett.\n'
    + ' */\n'
    + 'window.SCENARIO_DATA = ' + JSON.stringify(data, null, 2) + ';\n';

fs.writeFileSync(path.resolve(__dirname, 'scenario-data.js'), out, 'utf8');
console.log('Skrev scenario-data.js fra ' + src + ' — «' + (data.meta && data.meta.title) + '»');
