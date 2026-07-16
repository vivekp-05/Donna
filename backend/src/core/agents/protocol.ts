import { extractJson } from './llm.js';

// Internal request protocol shared between the language agents and the
// deterministic mock. Each agent embeds a task tag + a JSON payload of its
// real inputs. The mock reads the payload and computes deterministically;
// live LLMs read the natural-language instructions and ignore the tag.

const TAG_RE = /<<DONNA_TASK:([a-z_]+)>>/i;
const INPUT_MARKER = 'INPUT_JSON:';

export type DonnaTask =
  | 'intake'
  | 'offer'
  | 'callback'
  | 'manager'
  | 'explain';

export function buildTaskPrompt(
  task: DonnaTask,
  instructions: string,
  payload: unknown,
): string {
  return (
    `<<DONNA_TASK:${task}>>\n` +
    `${instructions}\n\n` +
    `${INPUT_MARKER}\n${JSON.stringify(payload)}`
  );
}

export interface ParsedTaskRequest {
  task: DonnaTask;
  input: Record<string, unknown>;
}

export function readTaskPrompt(prompt: string): ParsedTaskRequest | null {
  const m = TAG_RE.exec(prompt);
  if (!m) return null;
  const task = m[1].toLowerCase() as DonnaTask;
  let input: Record<string, unknown> = {};
  const idx = prompt.indexOf(INPUT_MARKER);
  if (idx >= 0) {
    const tail = prompt.slice(idx + INPUT_MARKER.length);
    try {
      input = extractJson<Record<string, unknown>>(tail);
    } catch {
      input = {};
    }
  }
  return { task, input };
}
