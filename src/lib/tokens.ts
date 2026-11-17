/**
 * Conservative token estimate for context budgeting (Ollama has no tokenize API). Weights
 * come from measuring qwen3:8b: English prose ~5.4 chars/token, SQL ~3.4, JSON ~2.3, Persian
 * ~3.1 UTF-8 bytes/token, and every digit is its own token. Counting digits as 1, other ASCII
 * as 0.4 and other characters as half their UTF-8 bytes overestimates prose, SQL, JSON and
 * Persian, but can undercount dense numeric data (CSV, hex) by ~15%. That is safe because
 * requests set `truncate: false`: Ollama rejects anything that still doesn't fit.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x30 && code <= 0x39) tokens += 1;
    else if (code < 0x80) tokens += 0.4;
    else tokens += (code < 0x800 ? 2 : code < 0x10000 ? 3 : 4) / 2;
  }
  return Math.ceil(tokens);
}
