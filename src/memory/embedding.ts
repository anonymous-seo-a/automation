import { config } from '../config';
import { logger } from '../utils/logger';

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';

/** テキストをベクトル化 */
export async function embed(text: string): Promise<number[]> {
  return (await embedBatch([text]))[0];
}

/** 複数テキストを一括ベクトル化（Voyage APIは最大128件/バッチ） */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!config.voyage.apiKey) {
    throw new Error('VOYAGE_API_KEY が設定されていません');
  }

  const results: number[][] = [];
  const batchSize = 128;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    const res = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.voyage.apiKey}`,
      },
      body: JSON.stringify({
        input: batch,
        model: config.voyage.model,
        input_type: 'document',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      logger.error('Voyage API error', { status: res.status, err });
      throw new Error(`Voyage API ${res.status}: ${err}`);
    }

    const data = await res.json() as {
      data: Array<{ embedding: number[] }>;
      usage: { total_tokens: number };
    };

    logger.info('Voyage embedding完了', {
      count: batch.length,
      tokens: data.usage.total_tokens,
    });

    for (const item of data.data) {
      results.push(item.embedding);
    }
  }

  return results;
}

/** クエリ用embedding（input_type: queryで精度向上） */
export async function embedQuery(text: string): Promise<number[]> {
  if (!config.voyage.apiKey) {
    throw new Error('VOYAGE_API_KEY が設定されていません');
  }

  const res = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.voyage.apiKey}`,
    },
    body: JSON.stringify({
      input: [text],
      model: config.voyage.model,
      input_type: 'query',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Voyage API ${res.status}: ${err}`);
  }

  const data = await res.json() as {
    data: Array<{ embedding: number[] }>;
  };

  return data.data[0].embedding;
}

/** cosine類似度 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** embeddingをBuffer（Float32Array）に変換して保存用に */
export function embeddingToBuffer(embedding: number[]): Buffer {
  const float32 = new Float32Array(embedding);
  return Buffer.from(float32.buffer);
}

/** BufferからFloat32Arrayを復元 */
export function bufferToEmbedding(buf: Buffer): number[] {
  const float32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(float32);
}
