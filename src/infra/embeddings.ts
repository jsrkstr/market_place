import OpenAI from 'openai';
import { config } from '../config.js';

export interface EmbeddingProvider {
  /** Returns one L2-normalised vector of config.EMBEDDING_DIMENSIONS per input text. */
  embed(texts: string[]): Promise<number[][]>;
}

class OpenAIEmbeddings implements EmbeddingProvider {
  private client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.client.embeddings.create({
      model: config.EMBEDDINGS_MODEL,
      input: texts,
      dimensions: config.EMBEDDING_DIMENSIONS,
    });
    return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

/** Light synonym folding so the offline provider behaves roughly like a semantic model in tests. */
const FAKE_SYNONYMS: Record<string, string> = {
  cream: 'offwhite', ivory: 'offwhite', 'off-white': 'offwhite', offwhite: 'offwhite', ecru: 'offwhite',
  beige: 'offwhite', sand: 'offwhite', white: 'white',
  sofa: 'sofa', couch: 'sofa', settee: 'sofa',
  chair: 'chair', chairs: 'chair', seat: 'chair',
  lamp: 'lamp', light: 'lamp', lighting: 'lamp',
  table: 'table', desk: 'desk', shelf: 'shelf', shelves: 'shelf', bookcase: 'shelf', shelving: 'shelf',
  wood: 'wood', wooden: 'wood', oak: 'wood', beech: 'wood', pine: 'wood', walnut: 'wood',
  modern: 'modern', contemporary: 'modern', minimalist: 'modern', scandinavian: 'scandi', nordic: 'scandi',
};

function fold(token: string): string {
  const t = token.toLowerCase();
  if (FAKE_SYNONYMS[t]) return FAKE_SYNONYMS[t];
  const singular = t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t;
  return FAKE_SYNONYMS[singular] ?? singular;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic bag-of-words hashing embedder. Offline, for tests and local demos without an API key. */
export class FakeEmbeddings implements EmbeddingProvider {
  constructor(private dims = config.EMBEDDING_DIMENSIONS) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const v = new Array<number>(this.dims).fill(0);
      const tokens = text.match(/[\p{L}\p{N}-]+/gu) ?? [];
      for (const raw of tokens) {
        const tok = fold(raw);
        if (tok.length < 2) continue;
        const h = hash(tok);
        v[h % this.dims] += h & 1 ? 1 : -1;
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

let provider: EmbeddingProvider | null = null;

export function getEmbeddings(): EmbeddingProvider {
  if (!provider) provider = config.EMBEDDINGS_PROVIDER === 'fake' ? new FakeEmbeddings() : new OpenAIEmbeddings();
  return provider;
}

export function setEmbeddingsForTesting(p: EmbeddingProvider | null): void {
  provider = p;
}

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await getEmbeddings().embed([text]);
  return v;
}
