import type { Unit } from '../quantity';

/** Where a spec value came from. Precedence when they disagree: manual > lcsc > description. */
export type Src = 'manual' | 'lcsc' | 'description';
export const SRC_RANK: Record<Src, number> = { manual: 3, lcsc: 2, description: 1 };

export interface SpecValue {
  /** A number in SI base units (see quantity.ts); or a range as min/max; or text for categorical specs. */
  n?: number; min?: number; max?: number; text?: string;
  unit?: string; raw: string; cond?: string; count?: number; src: Src;
}

/** What is stored in `parts.specs`. `title` is LCSC's one-line name, the fallback when nothing could be mapped. */
export interface PartSpecs { v: 1; family: string; title?: string; props: Record<string, SpecValue> }

export type SpecKind = 'number' | 'range' | 'text';

/** The LCSC response as stored in `part_enrichment.raw_json` (trimmed from the original; see lcsc.ts). */
export interface LcscDetail {
  productCode: string; productModel: string; brand?: string; catalog: string; parentCatalog?: string; package?: string;
  intro?: string; desc?: string; datasheet?: string; /** LCSC's first product image (https, LCSC host), if the response had one. */ image?: string; params: Array<{ name: string; value: string; number: number | null }>;
}

export interface SpecDef {
  key: string;
  label: string;
  kind: SpecKind;
  /** Expected unit of the parsed value; a value in any other unit is refused rather than guessed. */
  unit?: Unit;
  /** LCSC parameter labels that feed this spec, in order of preference. */
  lcsc: string[];
  /** For a range, which end to sort by. */
  end?: 'min' | 'max';
  /** Sort by another spec instead (LED colour sorts by wavelength). */
  sortVia?: string;
  /** Print the value (default: engineering notation with the unit). */
  fmt?: (v: SpecValue) => string;
  /** Build the value from the whole LCSC record (several labels, or text parsing). Overrides `lcsc`. */
  derive?: (d: LcscDetail) => SpecValue | null;
}

export interface ChainItem { key: string; dir: 'asc' | 'desc' }
export interface Preset { name: string; chain: ChainItem[] }

export interface Family {
  id: string;
  label: string;
  /** The owner's category this family belongs to (used when LCSC's own category is not known). */
  category: string;
  /** Does this LCSC category (`catalog`, under `parent`) belong to the family? */
  matches: (catalog: string, parent: string) => boolean;
  props: SpecDef[];
  /** Importance order, #0 first. The Value column shows the first AVAILABLE one; Key specs show the next few. */
  order: string[];
  /** How many tokens the Key specs cell holds before the column width cuts it. */
  keyCount: number;
  presets: Preset[];
}

/** Core (non-spec) columns a sort chain may use, as `col:<id>`. */
export const CORE_SORT_KEYS: Array<{ key: string; label: string }> = [
  { key: 'col:value', label: 'Value' }, { key: 'col:package', label: 'Footprint' }, { key: 'col:mpn', label: 'MPN' }, { key: 'col:usable', label: 'Usable stock' },
];
