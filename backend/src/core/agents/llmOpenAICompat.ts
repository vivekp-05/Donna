import type { LlmClient } from './llm.js';
import { ENV } from '../../config.js';

export interface OpenAICompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  label?: string;
}

// OpenAI-compatible chat client (§6/§10). POST {base}/chat/completions with
// Bearer auth. Serves any OpenAI-compatible endpoint:
//   - InsForge AI / OpenRouter (default, no options): INSFORGE_AI_BASE_URL,
//     INSFORGE_AI_KEY, INSFORGE_AI_MODEL (default anthropic/claude-sonnet-4.5).
//   - Google Gemini (§D.1): constructed with explicit options pointing at
//     https://generativelanguage.googleapis.com/v1beta/openai.
// Throws only when actually selected without config; keyless default is unaffected.
export class LlmOpenAICompat implements LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly label: string;

  constructor(options?: OpenAICompatOptions) {
    if (options) {
      this.baseUrl = options.baseUrl.replace(/\/+$/, '');
      this.apiKey = options.apiKey;
      this.model = options.model;
      this.label = options.label ?? 'OpenAI-compat';
    } else {
      this.baseUrl = ENV.insforgeAiBaseUrl.replace(/\/+$/, '');
      this.apiKey = ENV.insforgeAiKey;
      this.model = ENV.insforgeAiModel || 'anthropic/claude-sonnet-4.5';
      this.label = 'InsForge AI';
    }
    if (!this.baseUrl || !this.apiKey) {
      throw new Error(`${this.label} selected but its base URL / API key are not set`);
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
      throw new Error(`${this.label} API error ${res.status}: ${errBody.slice(0, 500)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return (data.choices?.[0]?.message?.content ?? '').trim();
  }
}
