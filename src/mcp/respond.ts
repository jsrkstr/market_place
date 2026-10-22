/**
 * Response helpers for MCP tools: structured content plus a short text summary, and safe error mapping.
 * Tools stay thin: parse args → call a domain service → `respond(...)`.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { DomainError } from '../domain/errors.js';

export interface ToolOutput {
  /** Concise, human-readable summary for the model to relay. Never include private data. */
  text: string;
  /** Machine-readable result (must be a JSON object). */
  data: Record<string, unknown>;
}

const ERROR_HINTS: Record<DomainError['code'], string> = {
  not_found: 'Check the id (use the list tools to find it) and try again.',
  forbidden: 'This item belongs to someone else, so it cannot be viewed or changed with this tool.',
  invalid: 'Fix the input and retry; ask the user only if the missing information is genuinely unknown.',
  conflict: 'The item changed or is in a state that does not allow this; refresh it and retry.',
  unauthenticated: 'The user needs to sign in to the marketplace again.',
};

/** Runs a tool body and converts its output or failure into a CallToolResult. */
export async function respond(fn: () => Promise<ToolOutput>): Promise<CallToolResult> {
  try {
    const { text, data } = await fn();
    return { content: [{ type: 'text', text }], structuredContent: toJson(data) };
  } catch (err) {
    return errorResult(err);
  }
}

export function errorResult(err: unknown): CallToolResult {
  if (err instanceof DomainError) {
    return {
      isError: true,
      content: [{ type: 'text', text: `${err.message}. ${ERROR_HINTS[err.code]}` }],
      structuredContent: { error: { code: err.code, message: err.message } },
    };
  }
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    return {
      isError: true,
      content: [{ type: 'text', text: `Invalid input: ${issues}` }],
      structuredContent: { error: { code: 'invalid', message: issues } },
    };
  }
  console.error('[mcp] tool failed', err);
  return {
    isError: true,
    content: [{ type: 'text', text: 'The marketplace hit an unexpected error. Please try again shortly.' }],
    structuredContent: { error: { code: 'internal', message: 'Unexpected server error' } },
  };
}

/** Strips undefined/Date/class instances so structuredContent is plain JSON. */
function toJson(data: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Formatting helpers for text summaries
// ---------------------------------------------------------------------------

/** 2000 EUR cents → "€20"; 1999 → "€19.99". */
export function formatPrice(cents: number | null | undefined, currency = 'EUR'): string {
  if (cents == null) return 'no price set';
  const whole = cents % 100 === 0;
  try {
    return new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(whole ? 0 : 2)} ${currency}`;
  }
}

export function formatRange(low: number | null | undefined, high: number | null | undefined, currency = 'EUR'): string | null {
  if (low == null && high == null) return null;
  if (low != null && high != null) return low === high ? formatPrice(low, currency) : `${formatPrice(low, currency)}–${formatPrice(high, currency)}`;
  return formatPrice((low ?? high)!, currency);
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function lines(...parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('\n');
}
