import type { LcscDetail } from './types';

interface RawResult {
  productCode?: string; productModel?: string; brandNameEn?: string; catalogName?: string; parentCatalogName?: string;
  encapStandard?: string; productIntroEn?: string; productDescEn?: string; pdfUrl?: string;
  paramVOList?: Array<{ paramNameEn?: string; paramValueEn?: string; paramValueEnForSearch?: number | null }> | null;
}

/**
 * Keep only what the app uses from LCSC's (large) product-detail response: the identity, category, datasheet link
 * and the labelled parameters. `null` means LCSC no longer lists the part (`result: null`). This is the shape
 * stored in part_enrichment.raw_json and used as test fixtures.
 */
export function trimLcscResponse(body: unknown): LcscDetail | null {
  const r = (body as { result?: RawResult | null } | null)?.result;
  if (!r || !r.productCode) return null;
  return {
    productCode: r.productCode, productModel: r.productModel ?? '', brand: r.brandNameEn, catalog: r.catalogName ?? '',
    parentCatalog: r.parentCatalogName, package: r.encapStandard, intro: r.productIntroEn, desc: r.productDescEn, datasheet: r.pdfUrl,
    params: (r.paramVOList ?? []).map((p) => ({ name: p.paramNameEn ?? '', value: p.paramValueEn ?? '', number: p.paramValueEnForSearch ?? null })).filter((p) => p.name),
  };
}
