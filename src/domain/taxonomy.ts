/**
 * Category taxonomy for household goods. Slugs are paths ("furniture/seating/dining-chair"), so a
 * subtree test is a prefix test, which also works in SQL (`category = $c OR category LIKE $c || '/%'`).
 *
 * To add a category, add a node to TREE: give it a slug segment, a label and synonyms (EN/FR).
 * Fields and `dimensionsMatter` are inherited from the nearest ancestor that sets them.
 */

export type ImportantField =
  | 'price'
  | 'location'
  | 'photos'
  | 'dimensions'
  | 'condition'
  | 'colour'
  | 'material'
  | 'brand'
  | 'model'
  | 'style'
  | 'wattage'
  | 'size';

interface NodeDef {
  key: string;
  label: string;
  synonyms?: string[];
  /** Whether width/depth/height are important for this branch (true for furniture, false for vases). */
  dimensionsMatter?: boolean;
  /** Fields worth asking the seller for, in addition to the universal ones (price, location, photos, condition). */
  fields?: ImportantField[];
  children?: NodeDef[];
}

export interface CategoryInfo {
  slug: string;
  label: string;
  parent: string | null;
  depth: number;
  synonyms: string[];
  dimensionsMatter: boolean;
  fields: ImportantField[];
}

const TREE: NodeDef[] = [
  {
    key: 'furniture',
    label: 'Furniture',
    synonyms: ['furniture', 'meuble', 'meubles', 'mobilier'],
    dimensionsMatter: true,
    fields: ['dimensions', 'colour', 'material', 'style', 'brand', 'model'],
    children: [
      {
        key: 'seating',
        label: 'Seating',
        synonyms: ['seating', 'chair', 'siege', 'chaise', 'assise'],
        children: [
          { key: 'dining-chair', label: 'Dining chair', synonyms: ['dining chair', 'kitchen chair', 'side chair', 'chaise de salle a manger', 'chaise de cuisine'] },
          { key: 'armchair', label: 'Armchair', synonyms: ['armchair', 'accent chair', 'lounge chair', 'club chair', 'recliner', 'fauteuil', 'bergere'] },
          { key: 'office-chair', label: 'Office chair', synonyms: ['office chair', 'desk chair', 'chaise de bureau', 'fauteuil de bureau'] },
          { key: 'sofa', label: 'Sofa', synonyms: ['sofa', 'couch', 'settee', 'loveseat', 'canape', 'sofa bed', 'canape lit', 'clic clac'] },
          { key: 'stool', label: 'Stool', synonyms: ['stool', 'bar stool', 'tabouret', 'tabouret de bar'] },
          { key: 'bench', label: 'Bench', synonyms: ['bench', 'banc', 'banquette'] },
        ],
      },
      {
        key: 'tables',
        label: 'Tables',
        synonyms: ['table', 'tables'],
        children: [
          { key: 'dining-table', label: 'Dining table', synonyms: ['dining table', 'kitchen table', 'table a manger', 'table de salle a manger', 'table de cuisine'] },
          { key: 'coffee-table', label: 'Coffee table', synonyms: ['coffee table', 'table basse', 'cocktail table'] },
          { key: 'side-table', label: 'Side table', synonyms: ['side table', 'end table', 'bedside table', 'nightstand', 'night stand', 'table de chevet', 'chevet', 'table d appoint', 'gueridon'] },
          { key: 'desk', label: 'Desk', synonyms: ['desk', 'writing desk', 'bureau', 'secretaire'] },
        ],
      },
      {
        key: 'storage',
        label: 'Storage',
        synonyms: ['storage', 'rangement'],
        children: [
          { key: 'shelf', label: 'Shelf', synonyms: ['shelf', 'shelves', 'shelving', 'shelving unit', 'wall shelf', 'etagere', 'etageres'] },
          { key: 'bookcase', label: 'Bookcase', synonyms: ['bookcase', 'bookshelf', 'book shelf', 'bibliotheque'] },
          { key: 'dresser', label: 'Dresser', synonyms: ['dresser', 'chest of drawers', 'drawers', 'commode', 'chiffonnier'] },
          { key: 'wardrobe', label: 'Wardrobe', synonyms: ['wardrobe', 'closet', 'armoire', 'penderie', 'garde robe'] },
          { key: 'sideboard', label: 'Sideboard', synonyms: ['sideboard', 'buffet', 'credenza', 'enfilade', 'tv stand', 'tv unit', 'meuble tv'] },
        ],
      },
      {
        key: 'beds',
        label: 'Beds',
        synonyms: ['bed', 'lit', 'bed frame', 'cadre de lit', 'sommier'],
        children: [{ key: 'mattress', label: 'Mattress', synonyms: ['mattress', 'matelas'] }],
      },
    ],
  },
  {
    key: 'lighting',
    label: 'Lighting',
    synonyms: ['lighting', 'lamp', 'luminaire', 'lampe', 'eclairage'],
    dimensionsMatter: false,
    fields: ['colour', 'material', 'style', 'brand', 'model'],
    children: [
      { key: 'floor-lamp', label: 'Floor lamp', synonyms: ['floor lamp', 'standing lamp', 'standard lamp', 'lampadaire', 'lampe sur pied'] },
      { key: 'table-lamp', label: 'Table lamp', synonyms: ['table lamp', 'desk lamp', 'bedside lamp', 'lampe de chevet', 'lampe de bureau', 'lampe a poser'] },
      { key: 'pendant', label: 'Pendant light', synonyms: ['pendant', 'pendant light', 'pendant lamp', 'ceiling light', 'ceiling lamp', 'chandelier', 'suspension', 'lustre', 'plafonnier'] },
      { key: 'wall-light', label: 'Wall light', synonyms: ['wall light', 'wall lamp', 'sconce', 'applique'] },
    ],
  },
  {
    key: 'decor',
    label: 'Decor',
    synonyms: ['decor', 'decoration', 'deco'],
    dimensionsMatter: false,
    fields: ['colour', 'material', 'style'],
    children: [
      { key: 'mirror', label: 'Mirror', synonyms: ['mirror', 'miroir', 'glace'], dimensionsMatter: true },
      { key: 'rug', label: 'Rug', synonyms: ['rug', 'carpet', 'runner', 'tapis'], dimensionsMatter: true },
      { key: 'vase', label: 'Vase', synonyms: ['vase', 'vases'] },
      { key: 'wall-art', label: 'Wall art', synonyms: ['wall art', 'painting', 'art print', 'poster', 'picture frame', 'picture', 'artwork', 'tableau', 'cadre', 'affiche'] },
      { key: 'plant-pot', label: 'Plant pot', synonyms: ['plant pot', 'planter', 'flower pot', 'pot de fleur', 'cache pot', 'jardiniere'] },
      { key: 'cushion', label: 'Cushion', synonyms: ['cushion', 'pillow', 'throw pillow', 'coussin'] },
      { key: 'curtain', label: 'Curtains', synonyms: ['curtain', 'curtains', 'drapes', 'rideau', 'rideaux'], dimensionsMatter: true },
    ],
  },
  {
    key: 'appliances',
    label: 'Appliances',
    synonyms: ['appliance', 'appliances', 'electromenager'],
    dimensionsMatter: false,
    fields: ['brand', 'model', 'colour'],
    children: [
      {
        key: 'small',
        label: 'Small appliances',
        synonyms: ['small appliance', 'petit electromenager'],
        children: [
          { key: 'coffee-machine', label: 'Coffee machine', synonyms: ['coffee machine', 'coffee maker', 'espresso machine', 'nespresso', 'machine a cafe', 'cafetiere'] },
          { key: 'kettle', label: 'Kettle', synonyms: ['kettle', 'bouilloire'] },
          { key: 'toaster', label: 'Toaster', synonyms: ['toaster', 'grille pain'] },
          { key: 'microwave', label: 'Microwave', synonyms: ['microwave', 'micro onde', 'micro ondes'] },
          { key: 'blender', label: 'Blender', synonyms: ['blender', 'mixer', 'food processor', 'mixeur', 'robot'] },
          { key: 'vacuum', label: 'Vacuum cleaner', synonyms: ['vacuum', 'vacuum cleaner', 'hoover', 'aspirateur'] },
          { key: 'fan-heater', label: 'Fan / heater', synonyms: ['fan', 'heater', 'radiator', 'ventilateur', 'chauffage', 'radiateur'] },
        ],
      },
      {
        key: 'large',
        label: 'Large appliances',
        synonyms: ['large appliance', 'gros electromenager'],
        dimensionsMatter: true,
        children: [
          { key: 'fridge', label: 'Fridge', synonyms: ['fridge', 'refrigerator', 'freezer', 'frigo', 'refrigerateur', 'congelateur'] },
          { key: 'washing-machine', label: 'Washing machine', synonyms: ['washing machine', 'washer', 'dryer', 'lave linge', 'seche linge'] },
          { key: 'oven', label: 'Oven / cooker', synonyms: ['oven', 'cooker', 'stove', 'hob', 'four encastrable', 'cuisiniere', 'plaque de cuisson'] },
          { key: 'dishwasher', label: 'Dishwasher', synonyms: ['dishwasher', 'lave vaisselle'] },
        ],
      },
    ],
  },
  {
    key: 'kitchenware',
    label: 'Kitchenware',
    synonyms: ['kitchenware', 'kitchen', 'cuisine', 'ustensiles'],
    dimensionsMatter: false,
    fields: ['brand', 'material', 'colour'],
    children: [
      { key: 'cookware', label: 'Pots and pans', synonyms: ['cookware', 'pot', 'pots', 'pan', 'pans', 'saucepan', 'frying pan', 'casserole', 'dutch oven', 'cocotte', 'poele', 'marmite'] },
      { key: 'tableware', label: 'Tableware', synonyms: ['tableware', 'plates', 'plate', 'bowls', 'dinner set', 'dishes', 'vaisselle', 'assiettes', 'bols'] },
      { key: 'glassware', label: 'Glassware', synonyms: ['glassware', 'glasses', 'wine glasses', 'carafe', 'verres'] },
      { key: 'cutlery', label: 'Cutlery', synonyms: ['cutlery', 'flatware', 'silverware', 'couverts'] },
      { key: 'utensils', label: 'Kitchen utensils', synonyms: ['utensils', 'kitchen tools', 'knives', 'knife', 'couteaux'] },
    ],
  },
  { key: 'other', label: 'Other', synonyms: ['other', 'misc', 'miscellaneous', 'autre', 'divers'], dimensionsMatter: false, fields: [] },
];

const BY_SLUG = new Map<string, CategoryInfo>();

(function build(nodes: NodeDef[], parent: CategoryInfo | null) {
  for (const n of nodes) {
    const slug = parent ? `${parent.slug}/${n.key}` : n.key;
    const info: CategoryInfo = {
      slug,
      label: n.label,
      parent: parent?.slug ?? null,
      depth: parent ? parent.depth + 1 : 1,
      synonyms: (n.synonyms ?? []).map(fold),
      dimensionsMatter: n.dimensionsMatter ?? parent?.dimensionsMatter ?? false,
      fields: n.fields ?? parent?.fields ?? [],
    };
    BY_SLUG.set(slug, info);
    if (n.children) build(n.children, info);
  }
})(TREE, null);

/** Lowercase, strip accents and punctuation, singularise simple plurals. Shared by normalize.ts. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map(singular)
    .join(' ');
}

function singular(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ves') && w !== 'curves') return `${w.slice(0, -3)}f`; // shelves → shelf
  if (w.endsWith('ss') || w.endsWith('us')) return w;
  if (w.endsWith('es') && /(ch|sh|x)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

export function getCategory(slug: string | null | undefined): CategoryInfo | null {
  return slug ? (BY_SLUG.get(slug) ?? null) : null;
}

export function allCategories(): CategoryInfo[] {
  return [...BY_SLUG.values()];
}

export function categoryLabel(slug: string | null | undefined): string | null {
  return getCategory(slug)?.label ?? null;
}

/** Ancestors of a slug, nearest first, excluding the slug itself. */
export function ancestors(slug: string): string[] {
  const out: string[] = [];
  let cur = getCategory(slug)?.parent ?? null;
  while (cur) {
    out.push(cur);
    cur = getCategory(cur)?.parent ?? null;
  }
  return out;
}

/** True when the listing's category equals the requested one or sits underneath it. */
export function isInSubtree(requestCategory: string | null | undefined, listingCategory: string | null | undefined): boolean {
  if (!requestCategory) return true;
  if (!listingCategory) return false;
  return listingCategory === requestCategory || listingCategory.startsWith(`${requestCategory}/`);
}

export function dimensionsMatter(slug: string | null | undefined): boolean {
  return getCategory(slug)?.dimensionsMatter ?? false;
}

export function importantFields(slug: string | null | undefined): ImportantField[] {
  return getCategory(slug)?.fields ?? ['colour', 'material', 'brand'];
}

// Synonym index: folded phrase → slugs that use it (a phrase may name a branch, e.g. "chair" → seating).
const PHRASES: { phrase: string; words: number; slug: string }[] = [];
for (const c of BY_SLUG.values()) {
  const phrases = new Set([...c.synonyms, fold(c.label), fold(c.slug.split('/').pop()!.replace(/-/g, ' '))]);
  for (const p of phrases) if (p) PHRASES.push({ phrase: p, words: p.split(' ').length, slug: c.slug });
}

/**
 * Resolve a slug or free text ("white IKEA dining chair", "table basse", "lampe") to a category slug.
 * The longest matching phrase wins (so "table lamp" beats "table"); ties go to the more specific
 * category, then to the earliest phrase in the text. Returns null when nothing matches.
 */
export function resolveCategory(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (BY_SLUG.has(trimmed)) return trimmed;
  // Partial slug such as "seating/dining-chair" or "dining-chair".
  for (const slug of BY_SLUG.keys()) if (slug.endsWith(`/${trimmed}`)) return slug;

  const text = ` ${fold(trimmed)} `;
  let best: { slug: string; words: number; pos: number; depth: number } | null = null;
  for (const p of PHRASES) {
    const pos = text.indexOf(` ${p.phrase} `);
    if (pos < 0) continue;
    const depth = BY_SLUG.get(p.slug)!.depth;
    const better =
      !best ||
      p.words > best.words ||
      (p.words === best.words && depth > best.depth) ||
      (p.words === best.words && depth === best.depth && pos < best.pos);
    if (better) best = { slug: p.slug, words: p.words, pos, depth };
  }
  return best?.slug ?? null;
}
