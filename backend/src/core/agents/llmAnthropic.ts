import type { LlmClient } from './llm.js';
import { ENV } from '../../config.js';

// Live Anthropic Messages API client (§6). Model claude-opus-4-8, ANTHROPIC_API_KEY.
// Constructed only when LLM_PROVIDER=anthropic; throws only when actually selected
// without a key, so mock/default paths never require secrets.
export class LlmAnthropic implements LlmClient {
  private readonly apiKey: string;
  private readonly model = 'claude-opus-4-8';
  private readonly endpoint = 'https://api.anthropic.com/v1/messages';

  constructor() {
    this.apiKey = ENV.anthropicApiKey;
    if (!this.apiKey) {
      throw new Error('LlmAnthropic selected but ANTHROPIC_API_KEY is not set');
    }
  }

  async complete(opts: { system?: string; prompt: string; json?: boolean }): Promise<string> {
    const system = [
      opts.system ?? 'You are Donna, a food-rescue dispatch assistant.',
      opts.json ? 'Respond with a single valid JSON value and nothing else.' : '',
    ]
      .filter(Boolean)
      .join(' ');

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1500,
        system,
        messages: [{ role: 'user', content: opts.prompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    return text.trim();
  }
}
