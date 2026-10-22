/**
 * Ranking of listings that already passed the hard filter. Every component is in 0..1 and kept in
 * the breakdown so explanations can be produced deterministically.
 */
import type { ListingRow } from '../../db/schema.js';
import { attributeDisplay, attributeFamilies, canonicalAttributeKey, familySimilarity, wantedFamilies } from '../normalize.js';
import { isInSubtree } from '../taxonomy.js';
import type { ScoreBreakdown } from '../types.js';
import type { Evaluation, RequestLike } from './hardFilter.js';

export const WEIGHTS = {
  semantic: 0.35,
  attributeFit: 0.35,
  distance: 0.1,
  price: 0.1,
  completeness: 0.05,
  freshness: 0.05,
} as const;

/** Minimum overall score for a listing to be suggested at all. */
export const MIN_SCORE = 0.45;
/** With soft preferences, a listing whose known attributes contradict nearly all of them is not suggested. */
export const MIN_ATTRIBUTE_FIT = 0.3;
/** Minimum semantic component, unless the structured preferences fit very well. */
export const MIN_SEMANTIC = 0.15;
/** A preference weighted at least this much acts as a filter when the listing clearly contradicts it. */
export const STRONG_PREFERENCE_WEIGHT = 0.7;
/** Family similarity below this counts as a clear contradiction (e.g. sage green vs beige). */
export const CLEAR_MISMATCH = 0.3;
export const DEFAULT_LIMIT = 5;
/** Availability unconfirmed for longer than this starts to rank lower. */
export const FRESH_DAYS = 14;

/** Raw cosine → 0..1. Text embeddings rarely go below ~0.1 for any pair or above ~0.7 for paraphrases. */
export function semanticComponent(cosine: number | null): number {
  if (cosine == null) return 0.3;
  return clamp((cosine - 0.1) / 0.5);
}

/** Penalty for similarity to listings the buyer dismissed for this request (raw cosine in). */
export function feedbackPenalty(maxDismissedCosine: number | null): number {
  if (maxDismissedCosine == null) return 0;
  return 0.3 * clamp((maxDismissedCosine - 0.7) / 0.25);
}

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

export interface ScoreResult {
  score: number;
  breakdown: ScoreBreakdown;
  /** Above the relevance threshold. */
  relevant: boolean;
}

export function scoreListing(input: {
  listing: ListingRow;
  request: RequestLike;
  evaluation: Evaluation;
  cosine: number | null;
  maxDismissedCosine?: number | null;
  now?: Date;
}): ScoreResult {
  const { listing, request, evaluation } = input;
  const hc = request.hardConstraints ?? {};
  const now = input.now ?? new Date();

  // Attribute / preference fit, with category specificity as one weighted entry.
  const preferenceHits: ScoreBreakdown['preferenceHits'] = [];
  let fitSum = 0;
  let weightSum = 0;
  let strongMismatch = false;
  for (const pref of request.softPreferences ?? []) {
    if (!pref.values?.length) continue;
    const w = pref.weight ?? 0.5;
    const found = attributeFamilies(listing.attributes, pref.attribute);
    const shown = attributeDisplay(listing.attributes, pref.attribute);
    let s: number;
    if (!found) s = 0.35; // unknown: mildly below neutral, never a hit
    else {
      s = familySimilarity(pref.attribute, wantedFamilies(pref.attribute, pref.values), found);
      const av = listing.attributes[canonicalAttributeKey(pref.attribute)];
      if (av?.source?.startsWith('ai_')) s *= 0.85; // inferred values count a little less
    }
    // Only known values can contradict; unknowns stay eligible so sellers can be asked to fill them in.
    if (found && w >= STRONG_PREFERENCE_WEIGHT && s < CLEAR_MISMATCH) strongMismatch = true;
    preferenceHits.push({ attribute: pref.attribute, wanted: pref.values, found: shown ? shown.split(', ') : null, matched: s >= 0.85 });
    fitSum += s * w;
    weightSum += w;
  }
  const categoryFit = !request.category || isInSubtree(request.category, listing.category) ? 1 : 0.5;
  const attributeFit = weightSum > 0 ? (fitSum + categoryFit * 0.3) / (weightSum + 0.3) : 0.6 * categoryFit;

  // Distance decay: 1 at the door, 0.5 at the buyer's limit (or 10 km when no limit was given).
  const distance =
    evaluation.distanceKm == null ? 0.5 : 1 / (1 + evaluation.distanceKm / Math.max(hc.maxDistanceKm ?? 10, 0.5));

  // Price fit: cheaper within budget is better; over-budget near-misses score low.
  let price = 0.5;
  if (listing.priceCents == null) price = 0.3;
  else if (hc.maxPriceCents != null && hc.maxPriceCents > 0) {
    price = listing.priceCents <= hc.maxPriceCents ? 1 - 0.5 * (listing.priceCents / hc.maxPriceCents) : 0.2;
  }

  // Freshness of the seller's availability confirmation.
  const confirmed = listing.availabilityConfirmedAt ?? listing.publishedAt;
  let freshness = 0.5;
  if (confirmed) {
    const days = (now.getTime() - confirmed.getTime()) / 86_400_000;
    freshness = days <= FRESH_DAYS ? 1 : clamp(1 - (days - FRESH_DAYS) / 46, 0.2, 1);
  }

  const breakdown: ScoreBreakdown = {
    semantic: round(semanticComponent(input.cosine)),
    attributeFit: round(attributeFit),
    distance: round(distance),
    price: round(price),
    completeness: round(clamp(listing.completeness)),
    freshness: round(freshness),
    feedbackPenalty: round(feedbackPenalty(input.maxDismissedCosine ?? null)),
    preferenceHits,
    constraintChecks: evaluation.checks,
  };
  const score = round(
    WEIGHTS.semantic * breakdown.semantic +
      WEIGHTS.attributeFit * breakdown.attributeFit +
      WEIGHTS.distance * breakdown.distance +
      WEIGHTS.price * breakdown.price +
      WEIGHTS.completeness * breakdown.completeness +
      WEIGHTS.freshness * breakdown.freshness -
      breakdown.feedbackPenalty,
  );
  const relevant =
    score >= MIN_SCORE &&
    (breakdown.semantic >= MIN_SEMANTIC || breakdown.attributeFit >= 0.8) &&
    (weightSum === 0 || breakdown.attributeFit >= MIN_ATTRIBUTE_FIT) &&
    !strongMismatch;
  return { score, breakdown, relevant };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
