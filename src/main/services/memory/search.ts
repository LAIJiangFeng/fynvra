// 记忆检索（ARCHITECTURE §7.15「检索」）：纯函数。英文数字按单词、中日韩按二元组；BM25 式打分与 Jaccard 相似度。

const CJK = '\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Hangul}';
const TOKEN_RE = new RegExp(`[${CJK}]+|(?:(?![${CJK}])[\\p{L}\\p{N}])+`, 'gu');
const CJK_RUN = new RegExp(`^[${CJK}]`, 'u');

/** 分词：转小写；中日韩连续段切成二元组，只有一个字时取单字。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const [run] of text.normalize('NFKC').toLowerCase().matchAll(TOKEN_RE)) {
    if (!CJK_RUN.test(run)) {
      tokens.push(run);
      continue;
    }
    const chars = [...run];
    if (chars.length === 1) tokens.push(run);
    for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}

/** 两段文本 token 集合的 Jaccard 相似度（0–1；都为空时为 0） */
export function jaccard(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

export interface SearchDoc {
  id: number;
  content: string;
  category: string;
  files: readonly string[];
}

// 字段权重：内容为主，类别与文件路径辅助
const FIELD_WEIGHTS = { content: 1, category: 0.5, files: 0.7 } as const;
const K1 = 1.2;
const B = 0.75;

/** BM25 式打分：返回得分 > 0 的 id，按得分降序（同分按 id 降序，新的在前）。 */
export function rankDocs(
  docs: readonly SearchDoc[],
  query: string
): { id: number; score: number }[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || docs.length === 0) return [];
  const weighted = docs.map((doc) => {
    const tf = new Map<string, number>();
    let length = 0;
    const add = (text: string, weight: number) => {
      for (const token of tokenize(text)) {
        tf.set(token, (tf.get(token) ?? 0) + weight);
        length += weight;
      }
    };
    add(doc.content, FIELD_WEIGHTS.content);
    add(doc.category, FIELD_WEIGHTS.category);
    add(doc.files.join(' '), FIELD_WEIGHTS.files);
    return { id: doc.id, tf, length };
  });
  const avgLength = weighted.reduce((sum, doc) => sum + doc.length, 0) / weighted.length || 1;
  const idf = new Map(
    terms.map((term) => {
      const df = weighted.filter((doc) => doc.tf.has(term)).length;
      return [term, Math.log(1 + (weighted.length - df + 0.5) / (df + 0.5))];
    })
  );
  const results: { id: number; score: number }[] = [];
  for (const doc of weighted) {
    let score = 0;
    for (const term of terms) {
      const freq = doc.tf.get(term);
      if (!freq) continue;
      score +=
        ((idf.get(term) ?? 0) * freq * (K1 + 1)) /
        (freq + K1 * (1 - B + (B * doc.length) / avgLength));
    }
    if (score > 0) results.push({ id: doc.id, score });
  }
  return results.sort((a, b) => b.score - a.score || b.id - a.id);
}
