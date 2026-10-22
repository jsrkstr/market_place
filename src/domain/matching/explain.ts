/**
 * Deterministic, concise explanations built from a score breakdown, e.g.
 * "Ivory (you wanted beige/off-white) · €20, within your €80 budget · ~1 km away · Wooden legs: not stated".
 * Model-inferred values are prefixed with "possibly"; nothing here is invented.
 */
import type { ListingRow } from '../../db/schema.js';
import { canonicalAttributeKey, CONDITION_LABEL, familySimilarity, formatPrice, vocabularyFor, wantedFamilies, attributeFamilies } from '../normalize.js';
import type { ScoreBreakdown } from '../types.js';
import type { Evaluation } from './hardFilter.js';
import { FRESH_DAYS } from './scorer.js';

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const ADJECTIVE: Record<string, string> = { wood: 'wooden', metal: 'metal', glass: 'glass', plastic: 'plastic', leather: 'leather' };

/** "legs_material" + ['wood'] → "wooden legs"; "colour" + ['beige'] → "beige colour". */
function preferenceLabel(attribute: string, wanted: string[]): string {
  const key = canonicalAttributeKey(attribute);
  const vocab = vocabularyFor(key);
  const part = key.replace(/_(material|colour)$/, '').replace(/_/g, ' ');
  const words = wanted.map((w) => ADJECTIVE[w.toLowerCase()] ?? w).join('/');
  if (vocab && key !== 'colour' && key !== 'material' && key !== 'style') return `${words} ${part}`;
  return vocab ? `${words} ${key}` : `${part}: ${words}`;
}

/** Noun suffix for sub-part attributes: legs_material → " legs". */
function partSuffix(attribute: string): string {
  const key = canonicalAttributeKey(attribute);
  if (!/_(material|colour)$/.test(key)) return '';
  return ` ${key.replace(/_(material|colour)$/, '').replace(/_/g, ' ')}`;
}

export function explainMatch(input: {
  listing: ListingRow;
  evaluation: Evaluation;
  breakdown: ScoreBreakdown;
  nearMiss: boolean;
  now?: Date;
}): string {
  const { listing, evaluation, breakdown } = input;
  const parts: string[] = [];
  const notStated: string[] = [];

  for (const hit of breakdown.preferenceHits) {
    if (!hit.found) {
      notStated.push(`${cap(preferenceLabel(hit.attribute, hit.wanted))}: not stated`);
      continue;
    }
    const av = listing.attributes[canonicalAttributeKey(hit.attribute)];
    const possibly = av?.source?.startsWith('ai_') ? 'possibly ' : '';
    const found = attributeFamilies(listing.attributes, hit.attribute) ?? [];
    const sim = familySimilarity(hit.attribute, wantedFamilies(hit.attribute, hit.wanted), found);
    const shown = `${hit.found.join('/')}${partSuffix(hit.attribute)}`;
    const wanted = hit.wanted.join('/');
    if (sim >= 1) parts.push(cap(`${possibly}${shown} (you wanted ${wanted})`));
    else if (sim > 0) parts.push(cap(`${possibly}${shown} (close to your ${wanted})`));
    else parts.push(cap(`${possibly}${shown}, not ${wanted}`));
  }

  const check = (name: string) => breakdown.constraintChecks.find((c) => c.constraint === name);
  const prefix = (ok: boolean | null | undefined) => (ok === false && input.nearMiss ? 'Near-miss: ' : '');

  const price = check('price');
  if (price && price.ok !== null) parts.push(prefix(price.ok) + cap(price.detail));
  else if (!price && listing.priceCents != null) parts.push(formatPrice(listing.priceCents, listing.currency));

  const dist = check('distance');
  if (dist && dist.ok !== null) parts.push(prefix(dist.ok) + dist.detail + (evaluation.approximateLocation && dist.ok ? ' (approx.)' : ''));
  else if (!dist && evaluation.distanceKm != null) {
    const km = evaluation.distanceKm < 1 ? Math.max(0.5, Math.round(evaluation.distanceKm * 2) / 2) : Math.round(evaluation.distanceKm);
    parts.push(`~${km} km away`);
  }

  if (listing.condition?.value) {
    const possibly = listing.condition.source.startsWith('ai_') ? 'possibly ' : '';
    parts.push(cap(`${possibly}${CONDITION_LABEL[listing.condition.value]}`));
  }
  const qty = check('quantity');
  if (qty?.ok) parts.push(qty.detail);
  for (const c of breakdown.constraintChecks) {
    if (c.ok && (c.constraint.startsWith('required.') || c.constraint.startsWith('dimensions.'))) parts.push(cap(c.detail));
  }

  for (const u of evaluation.unknowns) parts.push(cap(u));
  parts.push(...notStated);

  const confirmed = listing.availabilityConfirmedAt ?? listing.publishedAt;
  if (confirmed) {
    const days = Math.floor(((input.now ?? new Date()).getTime() - confirmed.getTime()) / 86_400_000);
    if (days > FRESH_DAYS) parts.push(`Availability last confirmed ${days} days ago`);
  }
  return [...new Set(parts)].join(' · ');
}
