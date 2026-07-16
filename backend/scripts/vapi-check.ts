/**
 * §D.6 — VAPI key validation. Read-only: GETs the account's phone numbers and
 * prints status + any phone-number ids. It NEVER places a call.
 *
 * Run once from backend/:  npx tsx scripts/vapi-check.ts
 *
 * Uses VAPI_API_KEY from backend/.env (loaded by config.ts at import time).
 * If exactly one phone number exists, its id is the value to put in
 * .env VAPI_PHONE_NUMBER_ID.
 */
import { ENV } from '../src/config.js';

const VAPI_BASE = 'https://api.vapi.ai';

interface PhoneNumber {
  id?: string;
  number?: string;
  name?: string;
  provider?: string;
  status?: string;
}

async function main(): Promise<void> {
  if (!ENV.vapiApiKey) {
    console.error('VAPI_API_KEY is not set (backend/.env). Nothing to check.');
    process.exitCode = 1;
    return;
  }

  let res: Response;
  try {
    res = await fetch(`${VAPI_BASE}/phone-number`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${ENV.vapiApiKey}` },
    });
  } catch (e) {
    console.error('Request failed:', e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return;
  }

  console.log(`GET ${VAPI_BASE}/phone-number -> HTTP ${res.status} ${res.statusText}`);

  const text = await res.text();
  if (!res.ok) {
    console.error('Key check failed. Response body:');
    console.error(text.slice(0, 1000));
    process.exitCode = 1;
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    console.log('Response was not JSON:');
    console.log(text.slice(0, 1000));
    return;
  }

  const numbers: PhoneNumber[] = Array.isArray(data)
    ? (data as PhoneNumber[])
    : ((data as { results?: PhoneNumber[] }).results ?? []);

  console.log(`Key is VALID. ${numbers.length} phone number(s) on the account:`);
  for (const n of numbers) {
    console.log(`  - id=${n.id ?? '(none)'}  number=${n.number ?? '(none)'}  name=${n.name ?? ''}  provider=${n.provider ?? ''}  status=${n.status ?? ''}`);
  }

  if (numbers.length === 1 && numbers[0].id) {
    console.log('');
    console.log(`Exactly one number found. Set in backend/.env:`);
    console.log(`  VAPI_PHONE_NUMBER_ID=${numbers[0].id}`);
  } else if (numbers.length === 0) {
    console.log('No phone numbers provisioned yet — nothing to write to VAPI_PHONE_NUMBER_ID.');
  } else {
    console.log('Multiple numbers found — pick the intended one for VAPI_PHONE_NUMBER_ID manually.');
  }
}

main().catch((e) => {
  console.error('Unexpected error:', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
