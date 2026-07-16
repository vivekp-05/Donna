import { ENV } from '../../config.js';
import { LlmMock } from './llmMock.js';
import { LlmAnthropic } from './llmAnthropic.js';
import { LlmOpenAICompat } from './llmOpenAICompat.js';

export interface LlmClient {
  complete(opts: { system?: string; prompt: string; json?: boolean }): Promise<string>;
}

/**
 * Factory selecting the LLM implementation from env (§6/§10).
 * Default (no env) is the deterministic mock — the app runs keyless.
 * Live providers throw only when their constructor runs without a key, so
 * importing this module and the default mock path never require secrets.
 */
export function createLlm(): LlmClient {
  switch (ENV.llmProvider) {
    case 'anthropic':
      return new LlmAnthropic();
    case 'insforge':
      return new LlmOpenAICompat();
    case 'gemini':
      // §D.1 — Google's OpenAI-compatible endpoint, reusing LlmOpenAICompat.
      return new LlmOpenAICompat({
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: ENV.geminiApiKey,
        model: ENV.geminiModel || 'gemini-2.5-flash',
        label: 'Gemini',
      });
    case 'mock':
    default:
      return new LlmMock();
  }
}

/**
 * Tolerant JSON extractor. Handles:
 *  - raw JSON
 *  - ```json fenced``` and bare ``` fenced``` blocks
 *  - JSON embedded in prose (first balanced object/array, string-aware)
 * Throws only when no parseable JSON can be recovered.
 */
export function extractJson<T>(raw: string): T {
  if (raw == null) throw new Error('extractJson: empty input');
  let s = String(raw).trim();

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence && fence[1]) s = fence[1].trim();

  const direct = tryParse<T>(s);
  if (direct.ok) return direct.value;

  const candidate = findBalanced(s);
  if (candidate != null) {
    const scanned = tryParse<T>(candidate);
    if (scanned.ok) return scanned.value;
  }

  throw new Error('extractJson: no JSON found in input');
}

function tryParse<T>(s: string): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) as T };
  } catch {
    return { ok: false };
  }
}

/** First balanced {...} or [...] substring, respecting strings and escapes. */
function findBalanced(s: string): string | null {
  const objStart = s.indexOf('{');
  const arrStart = s.indexOf('[');
  if (objStart === -1 && arrStart === -1) return null;

  let start: number;
  let open: string;
  let close: string;
  if (arrStart === -1 || (objStart !== -1 && objStart < arrStart)) {
    start = objStart;
    open = '{';
    close = '}';
  } else {
    start = arrStart;
    open = '[';
    close = ']';
  }

  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
