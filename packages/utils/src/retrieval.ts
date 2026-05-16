import type { JsonObject } from "@real-estate/types";

export interface RetrievalCandidate {
  id: string;
  content: unknown;
  tags?: string[];
  relevanceScore: number;
  confidence: number;
  updatedAt: Date;
  vector?: number[];
}

export interface RankedRetrievalCandidate extends RetrievalCandidate {
  finalScore: number;
  decayFactor: number;
  explanation: JsonObject;
}

function tokenize(value: unknown): Set<string> {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const intersection = Array.from(a).filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function cosineSimilarity(a?: number[], b?: number[]): number {
  if (!a?.length || !b?.length) {
    return 0;
  }
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    left += a[index] * a[index];
    right += b[index] * b[index];
  }
  if (left === 0 || right === 0) {
    return 0;
  }
  return Math.max(0, dot / (Math.sqrt(left) * Math.sqrt(right)));
}

export function memoryDecayFactor(updatedAt: Date, now = new Date(), halfLifeDays = 90): number {
  const ageDays = Math.max(0, (now.getTime() - updatedAt.getTime()) / 86_400_000);
  return Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
}

export function rankRetrievalCandidates(input: {
  query: unknown;
  queryVector?: number[];
  candidates: RetrievalCandidate[];
  now?: Date;
  halfLifeDays?: number;
}): RankedRetrievalCandidate[] {
  const queryTokens = tokenize(input.query);
  return input.candidates
    .map((candidate) => {
      const similarity = jaccard(queryTokens, tokenize(candidate.content));
      const vectorSimilarity = cosineSimilarity(input.queryVector, candidate.vector);
      const tagBoost = (candidate.tags ?? []).some((tag) => queryTokens.has(tag.toLowerCase())) ? 0.08 : 0;
      const decayFactor = memoryDecayFactor(candidate.updatedAt, input.now, input.halfLifeDays);
      const finalScore = Math.max(
        0,
        Math.min(1, (similarity * 0.3 + vectorSimilarity * 0.25 + candidate.relevanceScore * 0.3 + candidate.confidence * 0.15 + tagBoost) * decayFactor)
      );
      return {
        ...candidate,
        finalScore,
        decayFactor,
        explanation: {
          similarity,
          vectorSimilarity,
          baseRelevance: candidate.relevanceScore,
          confidence: candidate.confidence,
          tagBoost,
          decayFactor
        }
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore || b.updatedAt.getTime() - a.updatedAt.getTime());
}

export function scoreEmbeddingQuality(pairs: Array<{ expectedSimilarity: number; actualSimilarity: number }>): {
  meanAbsoluteError: number;
  calibration: number;
} {
  if (pairs.length === 0) {
    return { meanAbsoluteError: 0, calibration: 1 };
  }
  const meanAbsoluteError = pairs.reduce((sum, pair) => sum + Math.abs(pair.expectedSimilarity - pair.actualSimilarity), 0) / pairs.length;
  return {
    meanAbsoluteError,
    calibration: Math.max(0, Math.min(1, 1 - meanAbsoluteError))
  };
}

export function scoreRetrievalRanking(expectedIds: string[], retrievedIds: string[]): {
  precisionAtK: number;
  recallAtK: number;
  meanReciprocalRank: number;
  ndcg: number;
} {
  const expected = new Set(expectedIds);
  const hits = retrievedIds.filter((id) => expected.has(id));
  const precisionAtK = retrievedIds.length === 0 ? 0 : hits.length / retrievedIds.length;
  const recallAtK = expected.size === 0 ? 1 : hits.length / expected.size;
  const firstHitIndex = retrievedIds.findIndex((id) => expected.has(id));
  const meanReciprocalRank = firstHitIndex === -1 ? 0 : 1 / (firstHitIndex + 1);
  const dcg = retrievedIds.reduce((score, id, index) => score + (expected.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const idealDcg = expectedIds.slice(0, retrievedIds.length).reduce((score, _id, index) => score + 1 / Math.log2(index + 2), 0);
  const ndcg = idealDcg === 0 ? 1 : dcg / idealDcg;

  return {
    precisionAtK,
    recallAtK,
    meanReciprocalRank,
    ndcg
  };
}
