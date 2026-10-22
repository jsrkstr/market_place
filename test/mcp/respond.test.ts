import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.js';
import { formatPrice, formatRange, respond } from '../../src/mcp/respond.js';

describe('respond helpers', () => {
  it('formats prices in minor units', () => {
    expect(formatPrice(2000)).toBe('€20');
    expect(formatPrice(1999, 'EUR')).toBe('€19.99');
    expect(formatPrice(null)).toBe('no price set');
    expect(formatRange(1500, 3000)).toBe('€15–€30');
  });

  it('returns structuredContent and text', async () => {
    const r = await respond(async () => ({ text: 'ok', data: { a: 1, when: new Date(0) } }));
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual({ a: 1, when: '1970-01-01T00:00:00.000Z' });
    expect(r.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('maps DomainError to a helpful isError result', async () => {
    const r = await respond(async () => {
      throw new DomainError('forbidden', 'You do not have access to this item');
    });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/do not have access/);
    expect(r.structuredContent).toEqual({ error: { code: 'forbidden', message: 'You do not have access to this item' } });
  });

  it('hides unexpected errors', async () => {
    const orig = console.error;
    console.error = () => {};
    const r = await respond(async () => {
      throw new Error('secret db detail');
    });
    console.error = orig;
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain('secret db detail');
  });
});
