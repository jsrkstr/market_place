import { describe, expect, it } from 'vitest';
import {
  familySimilarity,
  formatPrice,
  normalizeAttributes,
  normalizeTerms,
  parseCondition,
  parseDimensionsText,
  parsePrice,
  wantedFamilies,
} from '../../src/domain/normalize.js';
import { roundDistanceKm, toPublicListingView } from '../../src/domain/privacy.js';
import { dimensionsMatter, importantFields, isInSubtree, resolveCategory } from '../../src/domain/taxonomy.js';
import type { ListingRow } from '../../src/db/schema.js';

describe('taxonomy', () => {
  it('resolves free text (EN/FR) to the most specific category', () => {
    expect(resolveCategory('white IKEA dining chair')).toBe('furniture/seating/dining-chair');
    expect(resolveCategory('chaise')).toBe('furniture/seating');
    expect(resolveCategory('chairs')).toBe('furniture/seating');
    expect(resolveCategory('table basse en chêne')).toBe('furniture/tables/coffee-table');
    expect(resolveCategory('brass table lamp')).toBe('lighting/table-lamp');
    expect(resolveCategory('light grey sofa')).toBe('furniture/seating/sofa');
    expect(resolveCategory('lampadaire')).toBe('lighting/floor-lamp');
    expect(resolveCategory('bookshelves')).toBe('furniture/storage/bookcase');
    expect(resolveCategory('furniture/seating/armchair')).toBe('furniture/seating/armchair');
    expect(resolveCategory('armchair')).toBe('furniture/seating/armchair');
    expect(resolveCategory('spaceship')).toBeNull();
  });

  it('subtree: a request for chairs covers dining chairs and armchairs', () => {
    expect(isInSubtree('furniture/seating', 'furniture/seating/dining-chair')).toBe(true);
    expect(isInSubtree('furniture/seating', 'furniture/seating/armchair')).toBe(true);
    expect(isInSubtree('furniture/seating/dining-chair', 'furniture/seating/armchair')).toBe(false);
    expect(isInSubtree('furniture/seat', 'furniture/seating/sofa')).toBe(false);
    expect(isInSubtree(null, 'decor/vase')).toBe(true);
  });

  it('knows which fields matter per category', () => {
    expect(dimensionsMatter('furniture/seating/dining-chair')).toBe(true);
    expect(dimensionsMatter('decor/vase')).toBe(false);
    expect(dimensionsMatter('decor/rug')).toBe(true);
    expect(importantFields('furniture/tables/desk')).toContain('dimensions');
  });
});

describe('normalize', () => {
  it('folds cream/ivory/off-white/beige into one family and keeps the wording', () => {
    for (const w of ['cream', 'ivory', 'off-white', 'Ecru', 'beige', 'sand', 'crème', 'ivoire']) {
      expect(normalizeTerms('colour', w)[0]?.family, w).toBe('warm-white');
    }
    const attrs = normalizeAttributes({ color: { value: 'Ivory', source: 'seller_stated' } });
    expect(attrs.colour).toMatchObject({ value: ['Ivory'], normalized: ['warm-white'] });
    expect(familySimilarity('colour', wantedFamilies('colour', ['cream']), ['warm-white'])).toBe(1);
    expect(familySimilarity('colour', ['warm-white'], ['white'])).toBeGreaterThan(0);
    expect(familySimilarity('colour', ['warm-white'], ['black'])).toBe(0);
  });

  it('maps materials and styles to families', () => {
    expect(normalizeTerms('material', 'solid oak').map((t) => t.family)).toEqual(['wood']);
    expect(normalizeTerms('material', 'chêne massif and steel').map((t) => t.family)).toEqual(['wood', 'metal']);
    expect(normalizeTerms('material', 'wicker')[0].family).toBe('rattan');
    expect(normalizeTerms('style', 'mid-century modern')[0].family).toBe('mid-century');
    expect(normalizeTerms('style', 'contemporary')[0].family).toBe('modern');
    expect(normalizeTerms('colour', 'navy')[0].family).toBe('blue');
    expect(normalizeTerms('colour', 'charcoal')[0].family).toBe('grey');
    expect(normalizeTerms('colour', 'blurple')).toEqual([]);
  });

  it('normalises attribute keys and dimensions; drops unknowns', () => {
    const a = normalizeAttributes({
      width: { value: '45 cm', source: 'seller_stated' },
      height_cm: { value: 0.8, source: 'seller_stated' },
      brand: { value: ' IKEA ', source: 'ai_inferred', confidence: 0.7 },
      colour: { value: null, source: 'seller_stated' },
    });
    expect(a.width_cm.value).toBe(45);
    expect(a.brand).toEqual({ value: 'IKEA', source: 'ai_inferred', confidence: 0.7 });
    expect(a.colour).toBeUndefined();
    expect(parseDimensionsText('W45 x D50 x H80 cm')).toEqual({ widthCm: 45, depthCm: 50, heightCm: 80 });
    expect(parseDimensionsText('120x60x75')).toEqual({ widthCm: 120, depthCm: 60, heightCm: 75 });
  });

  it('parses conditions and prices', () => {
    expect(parseCondition('like_new')).toBe('like_new');
    expect(parseCondition('Comme neuf')).toBe('like_new');
    expect(parseCondition('good condition')).toBe('good');
    expect(parseCondition('bon état')).toBe('good');
    expect(parseCondition('some scratches')).toBe('fair');
    expect(parseCondition('à restaurer')).toBe('poor');
    expect(parseCondition('???')).toBeNull();
    expect(parsePrice('€20')).toEqual({ cents: 2000, currency: 'EUR' });
    expect(parsePrice('20,50 €')).toEqual({ cents: 2050, currency: 'EUR' });
    expect(parsePrice('1 200 euros')).toEqual({ cents: 120000, currency: 'EUR' });
    expect(parsePrice('$15.99')).toEqual({ cents: 1599, currency: 'USD' });
    expect(parsePrice('free?')).toBeNull();
    expect(formatPrice(2000)).toBe('€20');
    expect(formatPrice(2050, 'GBP')).toBe('£20.50');
  });
});

describe('privacy', () => {
  it('rounds distance (<1 km to 0.5 km steps) and hides exact location', () => {
    expect(roundDistanceKm(0.1)).toBe(0.5);
    expect(roundDistanceKm(0.8)).toBe(1);
    expect(roundDistanceKm(0.7)).toBe(0.5);
    expect(roundDistanceKm(1.4)).toBe(1);
    expect(roundDistanceKm(2.6)).toBe(3);
    const now = new Date();
    const row = {
      id: 'lst_x', sellerId: 'usr_secret', status: 'active', rawText: 'raw', title: 'Chair', description: null,
      category: 'furniture/seating/dining-chair', attributes: { address: { value: '1 rue X', source: 'seller_stated' } },
      priceCents: 2000, currency: 'EUR', priceSource: 'seller', priceEstimateLowCents: null, priceEstimateHighCents: null,
      condition: null, conditionRank: null, quantity: 1, exactLat: 48.8592, exactLng: 2.3797, exactAddress: '12 rue Secret',
      publicLat: 48.86, publicLng: 2.38, areaLabel: 'Paris 11e', pickupOptions: [], completeness: 0.5, missingFields: [],
      availabilityConfirmedAt: now, publishedAt: now, expiresAt: null, version: 1, embedding: null, contentHash: null,
      idempotencyKey: null, createdAt: now, updatedAt: now,
    } as ListingRow;
    const v = toPublicListingView(row, [], { lat: 48.8531, lng: 2.3692 });
    const json = JSON.stringify(v);
    expect(json).not.toContain('Secret');
    expect(json).not.toContain('usr_secret');
    expect(json).not.toContain('1 rue X');
    expect(json).not.toContain('48.8592');
    expect(v.approxDistanceKm).toBe(1);
    expect(v.areaLabel).toBe('Paris 11e');
  });
});
