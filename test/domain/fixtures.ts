import type { ListingInput } from '../../src/domain/listings.service.js';
import type { BuyerRequestInput } from '../../src/domain/requests.service.js';

/** The brief's seller example: "white IKEA dining chair, good condition, €20, Paris". */
export const sellerChair: ListingInput = {
  rawText: "I'm selling a white IKEA dining chair, good condition, 20 euros, pick-up in Paris",
  title: 'White IKEA dining chair',
  category: 'dining chair',
  attributes: {
    colour: { value: 'white', source: 'seller_stated' },
    brand: { value: 'IKEA', source: 'seller_stated' },
    model: { value: 'Ingolf', source: 'ai_inferred', confidence: 0.6 },
  },
  priceCents: 2000,
  condition: { value: 'good', source: 'seller_stated' },
  location: { text: 'Paris' },
};

/** The brief's buyer example. */
export const buyerChairs: BuyerRequestInput = {
  rawText: 'I want two modern beige or off-white dining chairs, preferably with wooden legs, good condition, max 80 euros each, within 2 km',
  summary: '2 modern beige/off-white dining chairs, wooden legs preferred',
  category: 'dining chair',
  hardConstraints: { maxPriceCents: 8000, currency: 'EUR', maxDistanceKm: 2, minCondition: 'good', quantity: 2 },
  softPreferences: [
    { attribute: 'colour', values: ['beige', 'off-white'], weight: 0.8 },
    { attribute: 'style', values: ['modern'], weight: 0.5 },
    { attribute: 'legs_material', values: ['wood'], weight: 0.5 },
  ],
  location: { text: 'Paris' },
};
