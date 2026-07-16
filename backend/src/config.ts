import type { Weights, AgentConfig } from './core/types.js';

export const DEFAULT_WEIGHTS: Weights = {
  feasibility: 0.30,
  coldchain: 0.15,
  capacity: 0.20,
  equity: 0.20,
  prefs: 0.15,
};

export type LlmProvider = 'mock' | 'anthropic' | 'insforge';
export type DbProvider = 'json' | 'insforge';
export type VoiceProvider = 'sim' | 'vapi';

export interface EnvConfig {
  llmProvider: LlmProvider;
  anthropicApiKey: string;
  insforgeAiBaseUrl: string;
  insforgeAiKey: string;
  insforgeAiModel: string;
  dbProvider: DbProvider;
  insforgeBaseUrl: string;
  insforgeApiKey: string;
  voiceProvider: VoiceProvider;
  vapiApiKey: string;
  vapiPhoneNumberId: string;
  port: number;
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  const v = (value ?? '').trim();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  return {
    llmProvider: pick(env.LLM_PROVIDER, ['mock', 'anthropic', 'insforge'] as const, 'mock'),
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
    insforgeAiBaseUrl: env.INSFORGE_AI_BASE_URL ?? '',
    insforgeAiKey: env.INSFORGE_AI_KEY ?? '',
    insforgeAiModel: env.INSFORGE_AI_MODEL ?? 'anthropic/claude-sonnet-4.5',
    dbProvider: pick(env.DB_PROVIDER, ['json', 'insforge'] as const, 'json'),
    insforgeBaseUrl: env.INSFORGE_BASE_URL ?? '',
    insforgeApiKey: env.INSFORGE_API_KEY ?? '',
    voiceProvider: pick(env.VOICE_PROVIDER, ['sim', 'vapi'] as const, 'sim'),
    vapiApiKey: env.VAPI_API_KEY ?? '',
    vapiPhoneNumberId: env.VAPI_PHONE_NUMBER_ID ?? '',
    port: Number.parseInt(env.PORT ?? '8787', 10) || 8787,
  };
}

export const ENV: EnvConfig = loadEnv();

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  weights: { ...DEFAULT_WEIGHTS },
  autopilot: false,
  avgSpeedMph: 30,
};
