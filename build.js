#!/usr/bin/env node
/**
 * Build script for our-providers
 * Bundles each provider from src/<provider>/ into providers/<provider>.js
 *
 * Usage:
 *   node build.js              # build all
 *   node build.js moviesmod    # build one
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');
const outDir = path.join(__dirname, 'providers');

// Modules the Nuvio app provides at runtime — don't bundle these
const EXTERNAL_MODULES = [
  'cheerio-without-node-native',
  'react-native-cheerio',
  'cheerio',
  'crypto-js',
  'axios',
];

function getProvidersToBuild() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
  if (args.length > 0) return args;
  if (!fs.existsSync(srcDir)) {
    console.error('❌ src/ not found');
    process.exit(1);
  }
  return fs.readdirSync(srcDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

async function buildProvider(name) {
  const entry = path.join(srcDir, name, 'index.js');
  const outFile = path.join(outDir, `${name}.js`);
  if (!fs.existsSync(entry)) {
    console.warn(`⚠️  Skipping ${name}: no src/${name}/index.js`);
    return false;
  }
  try {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      outfile: outFile,
      format: 'cjs',
      platform: 'neutral',
      target: 'es2016',
      minify: false,
      sourcemap: false,
      external: EXTERNAL_MODULES,
      banner: {
        js: `/**\n * ${name} — built ${new Date().toISOString()}\n */`,
      },
      logLevel: 'warning',
    });
    const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
    console.log(`✅ ${name}.js (${kb} KB)`);
    return true;
  } catch (err) {
    console.error(`❌ ${name} failed:`, err.message);
    return false;
  }
}

async function main() {
  const providers = getProvidersToBuild();
  if (providers.length === 0) {
    console.log('No providers in src/. Create one: mkdir -p src/moviesmod');
    return;
  }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  console.log(`\n📦 Building ${providers.length} provider(s)...\n`);
  let ok = 0, fail = 0;
  for (const p of providers) {
    (await buildProvider(p)) ? ok++ : fail++;
  }
  console.log(`\n✨ Done. ${ok} built, ${fail} failed.\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
