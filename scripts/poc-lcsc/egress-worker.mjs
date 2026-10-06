// Proof of concept: can a Cloudflare Worker fetch LCSC's product detail? Run on Cloudflare's edge with
//   npx wrangler dev scripts/poc-lcsc/egress-worker.mjs --remote --compatibility-date 2026-08-22
// then GET / . Makes a few requests, returns status codes and how many parameters came back. Not part of the app.
export default {
  async fetch() {
    const out = [];
    for (const code of ['C269266', 'C468240', 'C5240381']) {
      const t0 = Date.now();
      try {
        const res = await fetch(`https://wmsc.lcsc.com/ftps/wm/product/detail?productCode=${code}`, { headers: { 'user-agent': 'Mozilla/5.0 (kicad_partlib proof of concept)' } });
        const text = await res.text();
        let params = null, model = null;
        try { const j = JSON.parse(text); params = j.result?.paramVOList?.length ?? null; model = j.result?.productModel ?? null; } catch { /* not JSON */ }
        out.push({ code, status: res.status, ms: Date.now() - t0, bytes: text.length, model, params, head: res.ok ? undefined : text.slice(0, 120) });
      } catch (e) { out.push({ code, error: String(e), ms: Date.now() - t0 }); }
    }
    return Response.json(out, { headers: { 'content-type': 'application/json' } });
  },
};
