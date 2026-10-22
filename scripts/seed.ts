/**
 * Seeds ~50 realistic secondhand listings across Paris and nearby towns, spread over 8 sellers, plus
 * 3 saved buyer requests. Idempotent: listings use idempotency keys and requests are matched on raw text.
 *
 *   pnpm seed            (uses .env; with GEOCODER=fake, places map onto FAKE_PLACES names)
 */
import { config } from '../src/config.js';
import { closeDb } from '../src/db/client.js';
import { createListing, getMyListings, type ListingInput } from '../src/domain/listings.service.js';
import { createBuyerRequest, getMyRequests, type BuyerRequestInput } from '../src/domain/requests.service.js';
import type { AttributeValue, Condition, UserContext } from '../src/domain/types.js';
import { findOrCreateUserByEmail, updateProfile } from '../src/domain/users.service.js';
import { FAKE_PLACES } from '../src/infra/geocoder.js';
import { stopBoss } from '../src/infra/jobs.js';
import { registerAllHandlers } from '../src/jobs/handlers.js';

const said = <T>(value: T): AttributeValue<T> => ({ value, source: 'seller_stated' });
const guess = <T>(value: T, confidence = 0.7): AttributeValue<T> => ({ value, source: 'ai_inferred', confidence });
const cond = (value: Condition, inferred = false): AttributeValue<Condition> =>
  inferred ? { value, source: 'ai_inferred', confidence: 0.6 } : { value, source: 'seller_stated' };

/** Real place names; with the fake geocoder each maps to the nearest FAKE_PLACES key. */
const PLACES: Record<string, string> = {
  'Paris 11e': 'paris 11e',
  'Paris 12e': 'paris 12e',
  'Paris 15e': 'paris 15e',
  'Paris 18e': 'paris 18e',
  'Paris 20e': 'paris 20e',
  Bastille: 'bastille',
  Montreuil: 'montreuil',
  'Paris 3e': 'paris',
  'Paris 17e': 'paris 18e',
  Vincennes: 'montreuil',
  'Boulogne-Billancourt': 'paris 15e',
  'Saint-Ouen': 'paris 18e',
};
const place = (name: string) => {
  if (config.GEOCODER !== 'fake') return { text: name };
  const key = PLACES[name] ?? 'paris';
  if (!FAKE_PLACES[key]) throw new Error(`unknown fake place ${key}`);
  return { text: key };
};

interface Seed {
  key: string;
  seller: number;
  publish?: boolean;
  place: string;
  input: Omit<ListingInput, 'location'>;
}

const eur = (n: number) => n * 100;

const SEEDS: Seed[] = [
  // --- Dining chairs: many colours, materials, styles -------------------------------------------
  { key: 'ch-ikea-ingolf-white', seller: 0, place: 'Paris 11e', input: {
    title: 'White IKEA Ingolf dining chair', category: 'dining chair', priceCents: eur(20), quantity: 2,
    description: 'Two white wooden chairs, a few scuffs on the legs, sturdy.',
    attributes: { brand: said('IKEA'), model: guess('Ingolf', 0.6), colour: said(['white']), material: said(['wood']), style: guess(['scandinavian']), height_cm: said(91), width_cm: said(43), depth_cm: said(52) },
    condition: cond('good') } },
  { key: 'ch-cream-velvet', seller: 1, place: 'Paris 12e', input: {
    title: 'Cream velvet dining chairs (set of 4)', category: 'dining chair', priceCents: eur(120), quantity: 4,
    description: 'Ivory velvet upholstered chairs with black metal legs.',
    attributes: { colour: said(['ivory']), material: said(['velvet', 'metal']), style: guess(['modern']), legs_material: said('metal') },
    condition: cond('like_new') } },
  { key: 'ch-beige-linen', seller: 2, place: 'Bastille', input: {
    title: 'Beige linen dining chair', category: 'dining chair', priceCents: eur(35),
    description: 'Upholstered in beige linen, oak legs.',
    attributes: { colour: said(['beige']), material: said(['linen', 'oak']), style: guess(['modern']), legs_material: said('wood') },
    condition: cond('good', true) } },
  { key: 'ch-thonet-bentwood', seller: 3, place: 'Paris 3e', input: {
    title: 'Bentwood bistro chair, Thonet style', category: 'dining chair', priceCents: eur(45),
    description: 'Classic dark beech bentwood chair with cane seat.',
    attributes: { brand: guess('Thonet', 0.3), colour: said(['dark brown']), material: said(['beech', 'cane']), style: said(['vintage', 'bistro']) },
    condition: cond('fair') } },
  { key: 'ch-black-metal-tolix', seller: 4, place: 'Montreuil', input: {
    title: 'Black metal Tolix-style chairs x2', category: 'dining chair', priceCents: eur(50), quantity: 2,
    attributes: { colour: said(['black']), material: said(['steel']), style: said(['industrial']) },
    condition: cond('good') } },
  { key: 'ch-green-plastic', seller: 5, place: 'Paris 20e', input: {
    title: 'Sage green moulded plastic chair', category: 'dining chair', priceCents: eur(15),
    attributes: { colour: said(['sage green']), material: said(['plastic']), style: guess(['modern']) },
    condition: cond('good') } },
  { key: 'ch-eames-dsw-white', publish: false, seller: 6, place: 'Paris 15e', input: {
    title: 'Eames DSW style chair, white', category: 'dining chair', priceCents: null, priceEstimate: { lowCents: eur(25), highCents: eur(40) },
    description: 'White shell chair with wooden Eiffel legs. Replica.',
    attributes: { colour: said(['white']), material: said(['plastic', 'wood']), style: said(['mid-century']) },
    condition: cond('good', true) } },
  { key: 'ch-oak-scandi', seller: 7, place: 'Vincennes', input: {
    title: 'Solid oak Scandinavian dining chairs (6)', category: 'dining chair', priceCents: eur(240), quantity: 6,
    attributes: { colour: said(['natural oak']), material: said(['oak']), style: said(['scandinavian']), width_cm: said(46), depth_cm: said(50), height_cm: said(80) },
    condition: cond('like_new') } },
  { key: 'ch-rattan-caned', seller: 0, place: 'Paris 11e', input: {
    title: 'Rattan and walnut cane chair', category: 'dining chair', priceCents: eur(60),
    attributes: { colour: said(['walnut', 'natural']), material: said(['rattan', 'walnut']), style: guess(['boho', 'vintage']) },
    condition: cond('good') } },
  { key: 'ch-grey-fabric', seller: 1, place: 'Paris 17e', input: {
    title: 'Grey fabric dining chairs', category: 'dining chair', priceCents: eur(30), quantity: 2,
    attributes: { colour: said(['grey']), material: guess(['fabric', 'metal']) } } },
  { key: 'ch-blue-velvet', seller: 2, place: 'Boulogne-Billancourt', input: {
    title: 'Navy velvet chair with brass legs', category: 'dining chair', priceCents: eur(55),
    attributes: { colour: said(['navy blue']), material: said(['velvet', 'brass']), style: guess(['art deco']) },
    condition: cond('like_new') } },
  { key: 'ch-offwhite-boucle', seller: 3, place: 'Paris 12e', input: {
    title: 'Off-white bouclé dining chair', category: 'dining chair', priceCents: eur(70),
    attributes: { colour: said(['off-white']), material: said(['boucle']), style: said(['modern']) } } },
  { key: 'ch-pine-farmhouse', seller: 4, place: 'Saint-Ouen', input: {
    title: 'Pine farmhouse chairs, set of 4', category: 'dining chair', priceCents: eur(80), quantity: 4,
    attributes: { colour: guess(['honey']), material: said(['pine']), style: said(['rustic']) },
    condition: cond('fair') } },
  { key: 'ch-red-retro', seller: 5, place: 'Paris 18e', input: {
    title: 'Red retro vinyl kitchen chair', category: 'dining chair', priceCents: eur(25),
    attributes: { colour: said(['red']), material: said(['vinyl', 'chrome']), style: said(['retro']) } } },
  { key: 'ch-draft-unknown', seller: 6, publish: false, place: 'Paris 15e', input: {
    rawText: 'some old chairs from my grandmother, not sure what wood', category: 'dining chair', quantity: 3 } },

  // --- Tables ----------------------------------------------------------------------------------
  { key: 'tb-oak-dining', seller: 7, place: 'Vincennes', input: {
    title: 'Oak extendable dining table', category: 'dining table', priceCents: eur(280),
    attributes: { material: said(['oak']), colour: said(['natural oak']), style: guess(['scandinavian']), width_cm: said(160), depth_cm: said(90), height_cm: said(75) },
    condition: cond('good') } },
  { key: 'tb-round-white', seller: 0, place: 'Paris 11e', input: {
    title: 'Round white pedestal table, 4 seats', category: 'dining table', priceCents: eur(90),
    attributes: { colour: said(['white']), material: guess(['mdf']), style: guess(['tulip', 'mid-century']), width_cm: said(110) } } },
  { key: 'tb-coffee-marble', seller: 1, place: 'Paris 3e', input: {
    title: 'Marble-top coffee table', category: 'coffee table', priceCents: eur(150),
    attributes: { material: said(['marble', 'metal']), colour: said(['white', 'gold']), style: guess(['art deco']) },
    condition: cond('like_new') } },
  { key: 'tb-coffee-teak', seller: 2, place: 'Montreuil', input: {
    title: 'Teak mid-century coffee table', category: 'coffee table', priceCents: eur(110), priceEstimate: { lowCents: eur(80), highCents: eur(140) },
    attributes: { material: said(['teak']), style: guess(['mid-century'], 0.8) } } },
  { key: 'tb-desk-ikea', seller: 3, place: 'Paris 20e', input: {
    title: 'IKEA Linnmon desk, black', category: 'desk', priceCents: eur(25),
    attributes: { brand: said('IKEA'), model: said('Linnmon'), colour: said(['black']), width_cm: said(120), depth_cm: said(60) },
    condition: cond('good') } },
  { key: 'tb-bedside-rattan', seller: 4, place: 'Paris 12e', input: {
    title: 'Rattan bedside table', category: 'bedside table', priceCents: eur(30),
    attributes: { material: said(['rattan']), colour: guess(['natural']) } } },
  { key: 'tb-draft-desk', seller: 5, publish: false, place: 'Paris 18e', input: {
    title: 'Small writing desk', category: 'desk', rawText: 'old writing desk, need to measure it' } },

  // --- Lighting --------------------------------------------------------------------------------
  { key: 'lt-arc-floor', seller: 6, place: 'Paris 15e', input: {
    title: 'Arc floor lamp, brushed steel', category: 'floor lamp', priceCents: eur(65),
    attributes: { material: said(['steel', 'marble']), colour: said(['silver']), style: guess(['modern']), height_cm: said(200) },
    condition: cond('good') } },
  { key: 'lt-paper-pendant', seller: 7, place: 'Bastille', input: {
    title: 'Paper lantern pendant, Akari style', category: 'pendant light', priceCents: eur(40),
    attributes: { material: said(['paper']), colour: said(['white']), style: guess(['japandi']) } } },
  { key: 'lt-brass-table-lamp', seller: 0, place: 'Paris 11e', input: {
    title: 'Brass table lamp with green glass shade', category: 'table lamp', priceCents: eur(45),
    attributes: { material: said(['brass', 'glass']), colour: said(['green', 'gold']), style: said(['vintage', 'banker']) },
    condition: cond('good') } },
  { key: 'lt-ikea-tripod', seller: 1, place: 'Paris 17e', input: {
    title: 'Tripod floor lamp with linen shade', category: 'floor lamp', priceCents: eur(30),
    attributes: { brand: guess('IKEA', 0.5), material: said(['wood', 'linen']), colour: said(['beige']) } } },
  { key: 'lt-mushroom', seller: 2, place: 'Paris 18e', input: {
    title: 'Mushroom table lamp, orange', category: 'table lamp', priceCents: eur(35),
    attributes: { colour: said(['orange']), material: guess(['plastic']), style: said(['70s']) } } },
  { key: 'lt-wall-sconce', seller: 3, place: 'Saint-Ouen', input: {
    title: 'Pair of black wall sconces', category: 'wall light', priceCents: eur(40), quantity: 2,
    attributes: { colour: said(['black']), material: said(['metal']), style: guess(['industrial']) } } },
  { key: 'lt-draft-lamp', seller: 4, publish: false, place: 'Montreuil', input: {
    rawText: 'a lamp, works fine', category: 'lamp' } },

  // --- Storage & shelves -----------------------------------------------------------------------
  { key: 'st-billy-white', seller: 5, place: 'Paris 20e', input: {
    title: 'IKEA Billy bookcase, white', category: 'bookcase', priceCents: eur(35),
    attributes: { brand: said('IKEA'), model: said('Billy'), colour: said(['white']), width_cm: said(80), depth_cm: said(28), height_cm: said(202) },
    condition: cond('good') } },
  { key: 'st-kallax-4x4', seller: 6, place: 'Boulogne-Billancourt', input: {
    title: 'IKEA Kallax 4x4 shelf, oak effect', category: 'shelf', priceCents: eur(60),
    attributes: { brand: said('IKEA'), model: said('Kallax'), colour: said(['oak effect']), width_cm: said(147), height_cm: said(147) } } },
  { key: 'st-wall-shelf-walnut', seller: 7, place: 'Paris 3e', input: {
    title: 'Floating walnut wall shelves (3)', category: 'shelf', priceCents: eur(45), quantity: 3,
    attributes: { material: said(['walnut']), width_cm: said(80) } } },
  { key: 'st-string-shelf', publish: false, seller: 0, place: 'Paris 11e', input: {
    title: 'String-style wall shelving system', category: 'shelf', priceCents: null, priceEstimate: { lowCents: eur(150), highCents: eur(250) },
    attributes: { brand: guess('String', 0.4), colour: said(['white']), style: said(['mid-century', 'scandinavian']) } } },
  { key: 'st-sideboard-teak', seller: 1, place: 'Vincennes', input: {
    title: 'Danish teak sideboard', category: 'sideboard', priceCents: eur(420),
    attributes: { material: said(['teak']), style: said(['mid-century']), width_cm: said(180), depth_cm: said(45), height_cm: said(78) },
    condition: cond('good') } },
  { key: 'st-dresser-pine', seller: 2, place: 'Paris 12e', input: {
    title: 'Pine chest of drawers', category: 'dresser', priceCents: eur(70),
    attributes: { material: said(['pine']), colour: guess(['honey']) } } },

  // --- Decor: mirrors, rugs, vases -------------------------------------------------------------
  { key: 'dc-mirror-round-brass', seller: 3, place: 'Paris 3e', input: {
    title: 'Round brass-framed mirror, 60 cm', category: 'mirror', priceCents: eur(55),
    attributes: { material: said(['brass', 'glass']), colour: said(['gold']), width_cm: said(60) },
    condition: cond('like_new') } },
  { key: 'dc-mirror-floor', seller: 4, place: 'Paris 17e', input: {
    title: 'Full-length floor mirror, black frame', category: 'mirror', priceCents: eur(40),
    attributes: { colour: said(['black']), height_cm: said(160) } } },
  { key: 'dc-mirror-sunburst', seller: 5, place: 'Montreuil', input: {
    title: 'Vintage sunburst mirror', category: 'mirror', priceCents: eur(85), priceEstimate: { lowCents: eur(60), highCents: eur(120) },
    attributes: { style: said(['vintage']), material: guess(['gilded wood'], 0.5) } } },
  { key: 'dc-rug-berber', seller: 6, place: 'Paris 15e', input: {
    title: 'Berber wool rug, cream with black lines', category: 'rug', priceCents: eur(180),
    attributes: { material: said(['wool']), colour: said(['cream', 'black']), style: said(['berber']), width_cm: said(170), depth_cm: said(240) },
    condition: cond('good') } },
  { key: 'dc-rug-jute', seller: 7, place: 'Paris 20e', input: {
    title: 'Round jute rug, 120 cm', category: 'rug', priceCents: eur(25),
    attributes: { material: said(['jute']), colour: said(['natural']), width_cm: said(120) } } },
  { key: 'dc-rug-kilim', seller: 0, place: 'Bastille', input: {
    title: 'Red kilim runner', category: 'rug', priceCents: eur(60),
    attributes: { colour: said(['red', 'blue']), style: said(['kilim']), material: guess(['wool']) } } },
  { key: 'dc-vase-ceramic', seller: 1, place: 'Paris 11e', input: {
    title: 'Speckled ceramic vase, handmade', category: 'vase', priceCents: eur(18),
    attributes: { material: said(['ceramic']), colour: said(['off-white']) } } },
  { key: 'dc-vase-glass-green', seller: 2, place: 'Paris 18e', input: {
    title: 'Green recycled glass vases (3)', category: 'vase', priceCents: eur(15), quantity: 3,
    attributes: { material: said(['glass']), colour: said(['green']) } } },
  { key: 'dc-vase-murano', publish: false, seller: 3, place: 'Paris 12e', input: {
    title: 'Murano-style glass vase', category: 'vase', priceCents: null, priceEstimate: { lowCents: eur(30), highCents: eur(90) },
    attributes: { brand: guess('Murano', 0.3), material: said(['glass']), colour: guess(['blue', 'amber']) } } },

  // --- Small appliances ------------------------------------------------------------------------
  { key: 'ap-nespresso', seller: 4, place: 'Paris 15e', input: {
    title: 'Nespresso Essenza Mini, red', category: 'coffee machine', priceCents: eur(45),
    attributes: { brand: said('Nespresso'), model: said('Essenza Mini'), colour: said(['red']) },
    condition: cond('like_new') } },
  { key: 'ap-delonghi-kettle', seller: 5, place: 'Paris 20e', input: {
    title: "De'Longhi kettle, cream", category: 'kettle', priceCents: eur(20),
    attributes: { brand: said("De'Longhi"), colour: said(['cream']) } } },
  { key: 'ap-smeg-toaster', seller: 6, place: 'Boulogne-Billancourt', input: {
    title: 'Smeg 2-slice toaster, pastel blue', category: 'toaster', priceCents: eur(70),
    attributes: { brand: said('Smeg'), colour: said(['pastel blue']), style: said(['retro']) },
    condition: cond('good') } },
  { key: 'ap-microwave', seller: 7, place: 'Saint-Ouen', input: {
    title: 'Samsung microwave 23L', category: 'microwave', priceCents: eur(40),
    attributes: { brand: said('Samsung'), colour: guess(['black']) } } },
  { key: 'ap-dyson-v8', seller: 0, place: 'Paris 11e', input: {
    title: 'Dyson V8 cordless vacuum', category: 'vacuum', priceCents: eur(150),
    attributes: { brand: said('Dyson'), model: said('V8') },
    condition: cond('good') } },
  { key: 'ap-blender', seller: 1, place: 'Paris 3e', input: {
    title: 'Moulinex blender', category: 'blender', priceCents: eur(15), priceEstimate: { lowCents: eur(10), highCents: eur(25) },
    attributes: { brand: said('Moulinex') } } },
  { key: 'ap-fan', seller: 2, place: 'Paris 17e', input: {
    title: 'Pedestal fan, white', category: 'fan', priceCents: eur(15),
    attributes: { colour: said(['white']) } } },
  { key: 'ap-draft-kettle', seller: 3, publish: false, place: 'Paris 12e', input: {
    rawText: 'kettle, used, brand unknown', category: 'kettle' } },
];

const SELLERS = [
  ['camille@seed.market.dev', 'Camille'],
  ['lucas@seed.market.dev', 'Lucas'],
  ['ines@seed.market.dev', 'Inès'],
  ['hugo@seed.market.dev', 'Hugo'],
  ['chloe@seed.market.dev', 'Chloé'],
  ['mehdi@seed.market.dev', 'Mehdi'],
  ['lea@seed.market.dev', 'Léa'],
  ['thomas@seed.market.dev', 'Thomas'],
] as const;

const REQUESTS: { email: string; name: string; place: string; input: Omit<BuyerRequestInput, 'location'> }[] = [
  { email: 'buyer.anna@seed.market.dev', name: 'Anna', place: 'Bastille', input: {
    rawText: 'I need two off-white dining chairs, under €80 total, within 3 km of Bastille, ideally modern with wooden legs',
    summary: '2 off-white dining chairs, ≤ €80, modern, wooden legs', category: 'dining chair',
    hardConstraints: { maxPriceCents: eur(80), maxDistanceKm: 3, quantity: 2 },
    softPreferences: [
      { attribute: 'colour', values: ['off-white'], weight: 0.8 },
      { attribute: 'style', values: ['modern'], weight: 0.5 },
      { attribute: 'legs_material', values: ['wood'], weight: 0.4 },
    ],
    allowExceptions: { budgetPct: 10 } } },
  { email: 'buyer.jules@seed.market.dev', name: 'Jules', place: 'Paris 11e', input: {
    rawText: 'Looking for a floor lamp for my living room, max 70 euros, Paris east',
    summary: 'Floor lamp, ≤ €70, east Paris', category: 'floor lamp',
    hardConstraints: { maxPriceCents: eur(70), maxDistanceKm: 8 } } },
  { email: 'buyer.sara@seed.market.dev', name: 'Sara', place: 'Paris 15e', input: {
    rawText: 'mid-century teak sideboard or coffee table, budget up to 300',
    summary: 'Mid-century teak storage or coffee table, ≤ €300', category: 'furniture',
    hardConstraints: { maxPriceCents: eur(300), maxDistanceKm: 15 },
    softPreferences: [
      { attribute: 'material', values: ['teak'], weight: 0.8 },
      { attribute: 'style', values: ['mid-century'], weight: 0.7 },
    ] } },
];

async function user(email: string, name: string): Promise<UserContext> {
  const u = await findOrCreateUserByEmail(email);
  if (!u.displayName) await updateProfile({ userId: u.id }, { displayName: name });
  return { userId: u.id };
}

async function main(): Promise<void> {
  registerAllHandlers(); // so inline jobs (JOBS_MODE=inline) produce matches/inbox items
  const sellers = await Promise.all(SELLERS.map(([email, name]) => user(email, name)));

  const before = new Set((await Promise.all(sellers.map((s) => getMyListings(s)))).flat().map((l) => l.id));
  const tally = { created: 0, existing: 0, published: 0, drafts: 0, blocked: [] as string[] };
  for (const s of SEEDS) {
    const r = await createListing(sellers[s.seller], {
      ...s.input,
      location: place(s.place),
      pickupOptions: ['pickup'],
      publish: s.publish !== false,
      idempotencyKey: `seed:${s.key}`,
    });
    if (r.duplicateOf || before.has(r.listing.id)) tally.existing++;
    else tally.created++;
    if (r.listing.status === 'active') tally.published++;
    else if (r.listing.status === 'draft') tally.drafts++;
    if (s.publish !== false && r.publishBlockers.length) tally.blocked.push(`${s.key}: ${r.publishBlockers.join('; ')}`);
  }

  const requestSummary: string[] = [];
  for (const q of REQUESTS) {
    const buyer = await user(q.email, q.name);
    const mine = await getMyRequests(buyer);
    if (mine.some((m) => m.rawText === q.input.rawText)) {
      requestSummary.push(`${q.name}: already seeded`);
      continue;
    }
    const res = await createBuyerRequest(buyer, { ...q.input, location: place(q.place) });
    requestSummary.push(`${q.name}: ${res.matches.length} matches, ${res.nearMisses.length} near-misses`);
  }

  console.log(`Seeded ${SEEDS.length} listings for ${sellers.length} sellers`);
  console.log(`  new: ${tally.created}, already present: ${tally.existing}, active: ${tally.published}, drafts: ${tally.drafts}`);
  if (tally.blocked.length) console.log(`  publish blocked:\n    ${tally.blocked.join('\n    ')}`);
  console.log(`Buyer requests:\n  ${requestSummary.join('\n  ')}`);
}

main()
  .then(async () => {
    await stopBoss();
    await closeDb();
  })
  .catch(async (err) => {
    console.error(err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
