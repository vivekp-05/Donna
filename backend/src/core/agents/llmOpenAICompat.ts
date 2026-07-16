import type { LlmClient } from './llm.js';
import { ENV } from '../../config.js';

// OpenAI-compatible chat client (§6/§10). Serves InsForge AI / OpenRouter:
// POST {base}/chat/completions with Bearer auth. Env: INSFORGE_AI_BASE_URL,
// INSFORGE_AI_KEY, INSFORGE_AI_MODEL (default anthropic/claude-sonnet-4.5).
// Throws only when actually selected without config; keyless default is unaffected.
export class LlmOpenAICompat implements LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor() {
    this.baseUrl = ENV.insforgeAiBaseUrl.replace(/\/+$/, '');
    this.apiKey = ENV.insforgeAiKey;
    this.model = ENV.insforgeAiModel || 'anthropic/claude-sonnet-4.5';
    if (!this.baseUrl || !this.apiKey) {
      throw new Error('LlmOpenAICompat selected but INSFORGE_AI_BASE_URL / INSFORGE_AI_KEY are not set');
    }
  }

  async complete(opts: { system?: string; prompt: string; json?: boolean }): Promise<string> {
    const system = [
      opts.system ?? 'You are Donna, a food-rescue dispatch assistant.',
      opts.json ? 'Respond with a single valid JSON value and nothing else.' : '',
    ]
      .filter(Boolean)
      .join(' ');

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: opts.prompt },
      ],
    };
    if (opts.json) body.response_format = { type: 'json_object' };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`OpenAI-compat API error ${res.status}: ${errBody.slice(0, 500)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return (data.choices?.[0]?.message?.content ?? '').trim();
  }
}
