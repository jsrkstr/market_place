/**
 * Normalisation of free-text attribute values into canonical families (colour, material, style),
 * plus condition, price and dimension parsing.
 *
 * Normalised attributes keep the original wording in `value` and the families in `normalized`, so
 * explanations can say "ivory (you wanted off-white)" while matching compares families.
 */
import { fold } from './taxonomy.js';
import type { AttributeValue, Attributes, Condition } from './types.js';
import { CONDITIONS } from './types.js';

export type Vocabulary = 'colour' | 'material' | 'style';

interface Family {
  label: string;
  terms: string[];
}

const COLOUR: Record<string, Family> = {
  white: { label: 'white', terms: ['white', 'pure white', 'bright white', 'snow white', 'blanc', 'blanche'] },
  'warm-white': {
    label: 'off-white',
    terms: ['off white', 'offwhite', 'cream', 'creme', 'ivory', 'ivoire', 'ecru', 'beige', 'sand', 'sable', 'oatmeal', 'bone', 'eggshell', 'champagne', 'warm white', 'blanc casse', 'greige', 'natural white', 'linen white'],
  },
  grey: { label: 'grey', terms: ['grey', 'gray', 'light grey', 'dark grey', 'charcoal', 'anthracite', 'slate', 'graphite', 'taupe', 'ash grey', 'gris', 'grise'] },
  black: { label: 'black', terms: ['black', 'noir', 'noire', 'ebony', 'jet black'] },
  brown: { label: 'brown', terms: ['brown', 'dark brown', 'chocolate', 'tan', 'camel', 'cognac', 'caramel', 'chestnut', 'mocha', 'espresso', 'walnut', 'teak', 'mahogany', 'marron', 'brun', 'chocolat', 'noyer'] },
  'natural-wood': { label: 'natural wood', terms: ['natural', 'natural wood', 'light wood', 'oak', 'honey', 'pine', 'birch', 'beech', 'naturel', 'bois naturel', 'bois clair', 'chene', 'wood', 'wooden'] },
  blue: { label: 'blue', terms: ['blue', 'navy', 'navy blue', 'dark blue', 'light blue', 'sky blue', 'cobalt', 'denim', 'indigo', 'petrol blue', 'bleu', 'marine', 'bleu marine', 'bleu canard'] },
  green: { label: 'green', terms: ['green', 'olive', 'sage', 'emerald', 'mint', 'khaki', 'forest green', 'bottle green', 'teal', 'vert', 'verte', 'kaki'] },
  red: { label: 'red', terms: ['red', 'burgundy', 'bordeaux', 'wine', 'maroon', 'cherry red', 'rouge'] },
  pink: { label: 'pink', terms: ['pink', 'blush', 'rose', 'dusty pink', 'rose poudre', 'fuchsia', 'salmon'] },
  orange: { label: 'orange', terms: ['orange', 'terracotta', 'rust', 'coral', 'peach', 'brique'] },
  yellow: { label: 'yellow', terms: ['yellow', 'mustard', 'ochre', 'ocher', 'jaune', 'moutarde', 'ocre'] },
  purple: { label: 'purple', terms: ['purple', 'violet', 'lilac', 'lavender', 'plum', 'mauve', 'aubergine'] },
  gold: { label: 'gold/brass', terms: ['gold', 'golden', 'brass', 'copper', 'bronze', 'dore', 'doree', 'laiton', 'cuivre'] },
  silver: { label: 'silver/chrome', terms: ['silver', 'chrome', 'chromed', 'stainless', 'argent', 'argente', 'chrome'] },
  transparent: { label: 'transparent', terms: ['clear', 'transparent', 'see through'] },
  multicolour: { label: 'multicolour', terms: ['multicolour', 'multicolor', 'multi', 'multicoloured', 'patterned', 'colorful', 'colourful', 'multicolore'] },
};

const MATERIAL: Record<string, Family> = {
  wood: {
    label: 'wood',
    terms: ['wood', 'wooden', 'solid wood', 'hardwood', 'timber', 'oak', 'beech', 'walnut', 'pine', 'teak', 'birch', 'ash', 'mahogany', 'cherry', 'acacia', 'bamboo', 'elm', 'bois', 'bois massif', 'massif', 'chene', 'hetre', 'noyer', 'pin', 'frene', 'merisier', 'bouleau'],
  },
  'engineered-wood': { label: 'engineered wood', terms: ['mdf', 'chipboard', 'particleboard', 'particle board', 'plywood', 'veneer', 'laminate', 'melamine', 'contreplaque', 'agglomere', 'stratifie', 'placage'] },
  metal: { label: 'metal', terms: ['metal', 'steel', 'stainless steel', 'iron', 'wrought iron', 'cast iron', 'aluminium', 'aluminum', 'chrome', 'brass', 'copper', 'zinc', 'metallic', 'acier', 'fer', 'fer forge', 'fonte', 'metallique', 'laiton', 'cuivre'] },
  rattan: { label: 'rattan/wicker', terms: ['rattan', 'wicker', 'cane', 'caning', 'seagrass', 'osier', 'rotin', 'cannage'] },
  plastic: { label: 'plastic', terms: ['plastic', 'polypropylene', 'acrylic', 'abs', 'resin', 'polycarbonate', 'perspex', 'plexiglass', 'plexiglas', 'plastique', 'resine'] },
  fabric: { label: 'fabric', terms: ['fabric', 'textile', 'upholstered', 'cotton', 'linen', 'wool', 'polyester', 'boucle', 'jute', 'tissu', 'coton', 'lin', 'laine', 'tissu bouclette', 'bouclette'] },
  velvet: { label: 'velvet', terms: ['velvet', 'velour', 'velours', 'corduroy'] },
  leather: { label: 'leather', terms: ['leather', 'genuine leather', 'cuir'] },
  'faux-leather': { label: 'faux leather', terms: ['faux leather', 'leatherette', 'pu leather', 'vegan leather', 'simili cuir', 'skai'] },
  glass: { label: 'glass', terms: ['glass', 'tempered glass', 'verre', 'smoked glass'] },
  marble: { label: 'marble', terms: ['marble', 'marbre'] },
  stone: { label: 'stone', terms: ['stone', 'granite', 'travertine', 'terrazzo', 'slate', 'pierre', 'travertin'] },
  ceramic: { label: 'ceramic', terms: ['ceramic', 'porcelain', 'stoneware', 'earthenware', 'terracotta', 'ceramique', 'porcelaine', 'gres', 'faience', 'terre cuite'] },
  paper: { label: 'paper', terms: ['paper', 'rice paper', 'papier'] },
};

const STYLE: Record<string, Family> = {
  modern: { label: 'modern', terms: ['modern', 'contemporary', 'moderne', 'contemporain', 'contemporaine', 'design'] },
  minimalist: { label: 'minimalist', terms: ['minimalist', 'minimal', 'minimaliste', 'clean lines', 'simple'] },
  scandinavian: { label: 'scandinavian', terms: ['scandinavian', 'scandi', 'nordic', 'danish', 'scandinave', 'nordique'] },
  'mid-century': { label: 'mid-century', terms: ['mid century', 'midcentury', 'mid century modern', 'mcm', 'fifties', 'sixties', '50s', '60s', 'annees 50', 'annees 60', 'vintage 60s'] },
  industrial: { label: 'industrial', terms: ['industrial', 'industriel', 'industrielle', 'loft', 'factory'] },
  vintage: { label: 'vintage', terms: ['vintage', 'retro', 'antique', 'ancien', 'ancienne', 'brocante', 'old'] },
  rustic: { label: 'rustic', terms: ['rustic', 'farmhouse', 'country', 'cottage', 'shabby chic', 'rustique', 'campagne', 'campagnard'] },
  classic: { label: 'classic', terms: ['classic', 'traditional', 'classique', 'traditionnel', 'baroque', 'louis xv', 'louis xvi', 'haussmannien'] },
  bohemian: { label: 'bohemian', terms: ['boho', 'bohemian', 'boheme', 'ethnic', 'ethnique'] },
  'art-deco': { label: 'art deco', terms: ['art deco', 'deco', 'art nouveau'] },
};

/** Partial-credit pairs between families (symmetric). */
const RELATED: Record<Vocabulary, Record<string, number>> = {
  colour: {
    'white|warm-white': 0.6,
    'brown|natural-wood': 0.6,
    'warm-white|natural-wood': 0.3,
    'grey|black': 0.3,
    'grey|silver': 0.4,
    'red|orange': 0.4,
    'red|pink': 0.3,
    'orange|yellow': 0.3,
    'pink|purple': 0.3,
    'gold|yellow': 0.3,
  },
  material: {
    'wood|engineered-wood': 0.5,
    'velvet|fabric': 0.5,
    'leather|faux-leather': 0.6,
    'marble|stone': 0.6,
    'rattan|wood': 0.2,
  },
  style: {
    'modern|minimalist': 0.7,
    'modern|scandinavian': 0.5,
    'minimalist|scandinavian': 0.6,
    'mid-century|vintage': 0.6,
    'mid-century|scandinavian': 0.4,
    'mid-century|modern': 0.3,
    'industrial|modern': 0.3,
    'vintage|classic': 0.3,
    'vintage|rustic': 0.3,
    'art-deco|vintage': 0.5,
  },
};

const VOCABS: Record<Vocabulary, Record<string, Family>> = { colour: COLOUR, material: MATERIAL, style: STYLE };

/** folded term → family, per vocabulary (first family wins for duplicated terms). */
const TERM_INDEX: Record<Vocabulary, Map<string, string>> = { colour: new Map(), material: new Map(), style: new Map() };
for (const vocab of Object.keys(VOCABS) as Vocabulary[]) {
  for (const [family, def] of Object.entries(VOCABS[vocab])) {
    for (const term of [family.replace(/-/g, ' '), ...def.terms]) {
      const key = fold(term);
      if (!TERM_INDEX[vocab].has(key)) TERM_INDEX[vocab].set(key, family);
    }
  }
}
const MAX_TERM_WORDS = 4;

export interface NormalizedTerm {
  family: string;
  original: string;
}

/**
 * Map free text to families. "Light grey / ivory" → [{grey, 'light grey'}, {warm-white, 'ivory'}].
 * Longest phrases win inside each part. Unrecognised text yields nothing (never guessed).
 */
export function normalizeTerms(vocab: Vocabulary, raw: string): NormalizedTerm[] {
  const out: NormalizedTerm[] = [];
  const index = TERM_INDEX[vocab];
  // A known family key (e.g. "warm-white") passes through as-is.
  if (VOCABS[vocab][raw.trim().toLowerCase()]) return [{ family: raw.trim().toLowerCase(), original: raw.trim() }];
  for (const part of raw.split(/,|\/|&|\+|;|\band\b|\bor\b|\bet\b|\bou\b|\bwith\b|\bavec\b/i)) {
    const original = part.trim();
    if (!original) continue;
    const words = fold(original).split(' ').filter(Boolean);
    let i = 0;
    while (i < words.length) {
      let hit: { family: string; len: number } | null = null;
      for (let len = Math.min(MAX_TERM_WORDS, words.length - i); len > 0; len--) {
        const family = index.get(words.slice(i, i + len).join(' '));
        if (family) {
          hit = { family, len };
          break;
        }
      }
      if (hit) {
        if (!out.some((t) => t.family === hit!.family)) out.push({ family: hit.family, original });
        i += hit.len;
      } else i++;
    }
  }
  return out;
}

export function familyLabel(vocab: Vocabulary, family: string): string {
  return VOCABS[vocab][family]?.label ?? family;
}

/** Which vocabulary (if any) governs an attribute key: colour, legs_colour → colour; material, legs_material → material. */
export function vocabularyFor(attribute: string): Vocabulary | null {
  const a = canonicalAttributeKey(attribute);
  if (a === 'colour' || a.endsWith('_colour')) return 'colour';
  if (a === 'material' || a.endsWith('_material')) return 'material';
  if (a === 'style') return 'style';
  return null;
}

const KEY_ALIASES: Record<string, string> = {
  color: 'colour',
  colors: 'colour',
  colours: 'colour',
  couleur: 'colour',
  materials: 'material',
  matiere: 'material',
  materiau: 'material',
  styles: 'style',
  marque: 'brand',
  make: 'brand',
  manufacturer: 'brand',
  modele: 'model',
  width: 'width_cm',
  depth: 'depth_cm',
  height: 'height_cm',
  length: 'width_cm',
  diameter: 'diameter_cm',
  leg_material: 'legs_material',
  legs: 'legs_material',
  leg_colour: 'legs_colour',
  frame: 'frame_material',
  seat: 'seat_material',
};

export function canonicalAttributeKey(key: string): string {
  const k = fold(key).replace(/ /g, '_').replace(/color/g, 'colour');
  return KEY_ALIASES[k] ?? k;
}

/** An attribute value after normalisation: `value` keeps the original wording, `normalized` the families. */
export interface NormalizedAttributeValue extends AttributeValue<string[]> {
  normalized: string[];
}

export function isNormalizedValue(v: AttributeValue | undefined): v is NormalizedAttributeValue {
  return !!v && Array.isArray((v as NormalizedAttributeValue).normalized);
}

const DIMENSION_KEYS = new Set(['width_cm', 'depth_cm', 'height_cm', 'diameter_cm', 'seat_height_cm', 'length_cm']);

/**
 * Normalise a whole attribute map: canonical keys, vocab families, numeric dimensions in cm.
 * Null/empty values are dropped: unknown stays unknown rather than becoming "".
 */
export function normalizeAttributes(attrs: Attributes | undefined | null): Attributes {
  const out: Attributes = {};
  if (!attrs) return out;
  for (const [rawKey, av] of Object.entries(attrs)) {
    if (!av || av.value == null || av.value === '') continue;
    const key = canonicalAttributeKey(rawKey);
    const source = av.source ?? 'seller_stated';
    const confidence = av.confidence;
    const vocab = vocabularyFor(key);
    if (vocab) {
      const originals = (Array.isArray(av.value) ? av.value : [av.value]).map((x) => String(x).trim()).filter(Boolean);
      if (!originals.length) continue;
      const normalized = [...new Set(originals.flatMap((o) => normalizeTerms(vocab, o).map((t) => t.family)))];
      const v: NormalizedAttributeValue = { value: originals, normalized, source, ...(confidence != null ? { confidence } : {}) };
      out[key] = v;
    } else if (DIMENSION_KEYS.has(key)) {
      const cm = parseLengthCm(av.value);
      if (cm != null) out[key] = { value: cm, source, ...(confidence != null ? { confidence } : {}) };
    } else if (key === 'dimensions' && typeof av.value === 'string') {
      const d = parseDimensionsText(av.value);
      const add = (k: string, n: number | undefined) => {
        if (n != null && out[k] == null) out[k] = { value: n, source, ...(confidence != null ? { confidence } : {}) };
      };
      add('width_cm', d.widthCm);
      add('depth_cm', d.depthCm);
      add('height_cm', d.heightCm);
      out.dimensions_text = { value: av.value.trim(), source };
    } else {
      const value = typeof av.value === 'string' ? av.value.trim() : av.value;
      out[key] = { value, source, ...(confidence != null ? { confidence } : {}) };
    }
  }
  return out;
}

/** Families of a listing attribute, or null when unknown. */
export function attributeFamilies(attrs: Attributes, attribute: string): string[] | null {
  const key = canonicalAttributeKey(attribute);
  const av = attrs[key];
  if (!av || av.value == null) return null;
  const vocab = vocabularyFor(key);
  if (vocab) {
    if (isNormalizedValue(av)) return av.normalized.length ? av.normalized : (av.value as string[]).map((x) => fold(String(x)));
    const raw = Array.isArray(av.value) ? av.value : [av.value];
    const fam = raw.flatMap((r) => normalizeTerms(vocab, String(r)).map((t) => t.family));
    return fam.length ? [...new Set(fam)] : raw.map((x) => fold(String(x)));
  }
  return (Array.isArray(av.value) ? av.value : [av.value]).map((x) => fold(String(x)));
}

/** Families wanted by a buyer for an attribute ("beige", "off-white" → ['warm-white']). */
export function wantedFamilies(attribute: string, values: string[]): string[] {
  const vocab = vocabularyFor(attribute);
  if (!vocab) return values.map((v) => fold(v));
  const fam = values.flatMap((v) => {
    const t = normalizeTerms(vocab, v);
    return t.length ? t.map((x) => x.family) : [fold(v)];
  });
  return [...new Set(fam)];
}

/** Similarity of two family sets for an attribute: 1 = same family, partial for related families, 0 = different. */
export function familySimilarity(attribute: string, wanted: string[], found: string[]): number {
  const vocab = vocabularyFor(attribute);
  let best = 0;
  for (const w of wanted) {
    for (const f of found) {
      if (w === f) return 1;
      if (!vocab) {
        if (f.includes(w) || w.includes(f)) best = Math.max(best, 0.8);
        continue;
      }
      best = Math.max(best, RELATED[vocab][`${w}|${f}`] ?? RELATED[vocab][`${f}|${w}`] ?? 0);
    }
  }
  return best;
}

/** Human-readable original wording of a listing attribute ("ivory", "oak and metal"). */
export function attributeDisplay(attrs: Attributes, attribute: string): string | null {
  const av = attrs[canonicalAttributeKey(attribute)];
  if (!av || av.value == null) return null;
  return Array.isArray(av.value) ? av.value.join(', ') : String(av.value);
}

// ---------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------
const CONDITION_PATTERNS: [RegExp, Condition][] = [
  [/\b(like new|as new|mint|excellent|comme neuf|tres bon etat|parfait etat|etat neuf|barely used|hardly used|nearly new)\b/, 'like_new'],
  [/\b(new|brand new|neuf|neuve|unused|sealed|never used|jamais servi|sous blister)\b/, 'new'],
  [/\b(good|very good|bon etat|bon|tres bon|well kept|lightly used|gently used)\b/, 'good'],
  [/\b(fair|used|worn|some wear|signs of use|etat correct|etat moyen|usage|use|scratches|scratched|rayure|rayures)\b/, 'fair'],
  [/\b(poor|damaged|broken|for parts|needs repair|to restore|a restaurer|abime|mauvais etat|casse|hs)\b/, 'poor'],
];

/** Parse a condition from a canonical value or free text ("comme neuf", "good condition"). Null when unclear. */
export function parseCondition(input: string | null | undefined): Condition | null {
  if (!input) return null;
  const raw = input.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((CONDITIONS as readonly string[]).includes(raw)) return raw as Condition;
  const text = ` ${input.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  for (const [re, c] of CONDITION_PATTERNS) if (re.test(text)) return c;
  return null;
}

export const CONDITION_LABEL: Record<Condition, string> = {
  new: 'new',
  like_new: 'like new',
  good: 'good condition',
  fair: 'fair condition',
  poor: 'poor condition',
};

// ---------------------------------------------------------------------------
// Price & currency
// ---------------------------------------------------------------------------
const CURRENCY_ALIASES: [RegExp, string][] = [
  [/€|\beur\b|\beuros?\b/i, 'EUR'],
  [/\$|\busd\b|\bdollars?\b/i, 'USD'],
  [/£|\bgbp\b|\bpounds?\b/i, 'GBP'],
  [/\bchf\b|\bfrancs? suisses?\b/i, 'CHF'],
];

export function normalizeCurrency(input: string | null | undefined, fallback = 'EUR'): string {
  if (!input) return fallback;
  const t = input.trim();
  if (/^[A-Za-z]{3}$/.test(t)) return t.toUpperCase();
  for (const [re, code] of CURRENCY_ALIASES) if (re.test(t)) return code;
  return fallback;
}

/**
 * Parse "€20", "20 €", "20,50€", "1 200 euros", "$15.99" → cents + currency.
 * Numbers are taken as whole currency units. Returns null when no amount is present.
 */
export function parsePrice(input: string | number | null | undefined, defaultCurrency = 'EUR'): { cents: number; currency: string } | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? { cents: Math.round(input * 100), currency: defaultCurrency } : null;
  const m = input.match(/\d[\d\s.,']*/);
  if (!m) return null;
  let num = m[0].trim().replace(/[\s']/g, '');
  // "1.200,50" / "1,200.50" / "20,50" / "1,200"
  const lastSep = Math.max(num.lastIndexOf(','), num.lastIndexOf('.'));
  if (lastSep >= 0) {
    const decimals = num.length - lastSep - 1;
    if (decimals === 1 || decimals === 2) {
      num = `${num.slice(0, lastSep).replace(/[.,]/g, '')}.${num.slice(lastSep + 1)}`;
    } else num = num.replace(/[.,]/g, '');
  }
  const value = Number(num);
  if (!Number.isFinite(value)) return null;
  let currency = defaultCurrency;
  for (const [re, code] of CURRENCY_ALIASES) if (re.test(input)) currency = code;
  return { cents: Math.round(value * 100), currency };
}

const SYMBOL: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };

export function formatPrice(cents: number, currency = 'EUR'): string {
  const units = cents / 100;
  const amount = Number.isInteger(units) ? String(units) : units.toFixed(2);
  return SYMBOL[currency] ? `${SYMBOL[currency]}${amount}` : `${amount} ${currency}`;
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------
/** "45", "45 cm", "1.2 m", "450mm", 45 → centimetres. */
export function parseLengthCm(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(',', '.').match(/(\d+(?:\.\d+)?)\s*(mm|cm|m)?\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'cm').toLowerCase();
  return unit === 'mm' ? n / 10 : unit === 'm' ? n * 100 : n;
}

/** "W45 x D50 x H80 cm" or "45x50x80" (width × depth × height). Labelled numbers win over position. */
export function parseDimensionsText(text: string): { widthCm?: number; depthCm?: number; heightCm?: number } {
  const t = text.toLowerCase().replace(',', '.');
  const unitMul = /\bmm\b/.test(t) ? 0.1 : /\d\s*m\b/.test(t) && !/cm/.test(t) ? 100 : 1;
  const labelled = (re: RegExp) => {
    const m = t.match(re);
    return m ? Number(m[1]) * unitMul : undefined;
  };
  const w = labelled(/(?:\bw|width|largeur|\bl)\s*[:=]?\s*(\d+(?:\.\d+)?)/);
  const d = labelled(/(?:\bd|depth|profondeur|\bp)\s*[:=]?\s*(\d+(?:\.\d+)?)/);
  const h = labelled(/(?:\bh|height|hauteur)\s*[:=]?\s*(\d+(?:\.\d+)?)/);
  if (w != null || d != null || h != null) return { widthCm: w, depthCm: d, heightCm: h };
  const nums = (t.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => Number(n) * unitMul);
  if (nums.length >= 3) return { widthCm: nums[0], depthCm: nums[1], heightCm: nums[2] };
  if (nums.length === 2) return { widthCm: nums[0], heightCm: nums[1] };
  return {};
}
