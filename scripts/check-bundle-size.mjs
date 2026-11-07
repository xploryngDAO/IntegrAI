#!/usr/bin/env node
/**
 * Orçamento de bundle do SPA (regressão de performance no CI).
 *
 * Falha se o chunk principal voltar a crescer (o code splitting reduziu de ~537 KiB
 * para ~243 KiB) ou se o total de JS/CSS passar dos limites acordados.
 *
 * Uso: node scripts/check-bundle-size.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'apps', 'web', 'dist', 'assets');

const MAIN_MAX_BYTES = 300 * 1024; // chunk da aplicação (sem vendors)
const TOTAL_JS_MAX_BYTES = 1_500 * 1024;
const TOTAL_CSS_MAX_BYTES = 150 * 1024;

function fail(message) {
  console.error(`[erro] ${message}`);
  process.exit(1);
}

let files;
try {
  files = readdirSync(ASSETS);
} catch {
  fail(`dist não encontrado em ${ASSETS}; rode o build do web antes`);
}

const js = files.filter((name) => name.endsWith('.js'));
const css = files.filter((name) => name.endsWith('.css'));
if (js.length === 0) fail('nenhum JS encontrado em dist/assets');

const size = (name) => statSync(join(ASSETS, name)).size;
const totalJs = js.reduce((sum, name) => sum + size(name), 0);
const totalCss = css.reduce((sum, name) => sum + size(name), 0);

// O entry é `index-*.js`; vendors têm nomes próprios (react/convergencia/icons).
const mainEntries = js.filter((name) => /^index-.*\.js$/.test(name));
if (mainEntries.length !== 1) {
  fail(`esperava exatamente 1 chunk index-*.js, encontrei ${mainEntries.length}`);
}
const main = mainEntries[0];
const mainBytes = size(main);

console.log(`main ${main}: ${(mainBytes / 1024).toFixed(1)} KiB`);
console.log(`total JS: ${(totalJs / 1024).toFixed(1)} KiB · total CSS: ${(totalCss / 1024).toFixed(1)} KiB`);

if (mainBytes > MAIN_MAX_BYTES) {
  fail(`chunk principal ${(mainBytes / 1024).toFixed(1)} KiB > orçamento ${MAIN_MAX_BYTES / 1024} KiB (quebrou o code splitting?)`);
}
if (totalJs > TOTAL_JS_MAX_BYTES) {
  fail(`JS total ${(totalJs / 1024).toFixed(1)} KiB > orçamento ${TOTAL_JS_MAX_BYTES / 1024} KiB`);
}
if (totalCss > TOTAL_CSS_MAX_BYTES) {
  fail(`CSS total ${(totalCss / 1024).toFixed(1)} KiB > orçamento ${TOTAL_CSS_MAX_BYTES / 1024} KiB`);
}

console.log('[ok] bundle dentro do orçamento');
