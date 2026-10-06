// Proof of concept (not part of the app): fetch LCSC's labelled product parameters for every C-number in the
// owner's fixtures and save a TRIMMED copy of each response as a test fixture. Polite: sequential, paced,
// resumable (skips what is already saved). Run: node scripts/poc-lcsc/fetch.mjs
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const SRC = 'tests/fixtures/lcsc';
const OUT = 'tests/fixtures/lcsc-detail';
mkdirSync(OUT, { recursive: true });

const codes = new Set();
for (const f of readdirSync(SRC).filter((n) => n.endsWith('.csv'))) {
  for (const line of readFileSync(`${SRC}/${f}`, 'utf8').split(/\r?\n/).slice(1)) {
    const m = /(?:^|,)(C\d+),/.exec(line); // first field is the C-number (purchase export) or second (cart export)
    if (m) codes.add(m[1]);
  }
}
console.log(`${codes.size} distinct C-numbers`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, notListed = 0, failed = 0, skipped = 0;
for (const code of [...codes].sort()) {
  const file = `${OUT}/${code}.json`;
  if (existsSync(file)) { skipped++; continue; }
  let body = null;
  for (let attempt = 1; attempt <= 2 && !body; attempt++) {
    try {
      const res = await fetch(`https://wmsc.lcsc.com/ftps/wm/product/detail?productCode=${code}`, { headers: { 'user-agent': 'Mozilla/5.0 (kicad_partlib proof of concept)' } });
      if (res.ok) body = await res.json();
      else console.log(`  ${code}: HTTP ${res.status}`);
    } catch (e) { console.log(`  ${code}: ${e.message}`); }
    if (!body) await sleep(1500);
  }
  if (!body) { failed++; continue; }
  const r = body.result;
  const trimmed = r ? {
    status: 'ok', productCode: r.productCode, productModel: r.productModel, brand: r.brandNameEn,
    catalog: r.catalogName, parentCatalog: r.parentCatalogName, catalogPath: (r.parentCatalogList ?? []).map((c) => c.catalogNameEn),
    package: r.encapStandard, intro: r.productIntroEn, desc: r.productDescEn, datasheet: r.pdfUrl,
    params: (r.paramVOList ?? []).map((p) => ({ name: p.paramNameEn, value: p.paramValueEn, number: p.paramValueEnForSearch })),
  } : { status: 'not_listed', productCode: code, code: body.code, msg: body.msg };
  writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), ...trimmed }, null, 1) + '\n');
  if (r) ok++; else notListed++;
  await sleep(350);
}
console.log({ ok, notListed, failed, skipped });
