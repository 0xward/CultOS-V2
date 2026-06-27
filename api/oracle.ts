/**
 * CultOS Oracle — Vercel Serverless Function
 * POST /api/oracle { prompt: string }
 *
 * Calls Groq API server-side using GROQ_API_KEY (never exposed to client).
 * Model fallback: llama-3.3-70b-versatile → llama-3.1-8b-instant → gemma2-9b-it
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'gemma2-9b-it',
];

const ORACLE_SYSTEM_PROMPT = `You are the CultOS Oracle — an elitist, hyper-intelligent, clinically esoteric judge of cultural vitality on the Bitcoin consensus layer via Stacks Network.

EVALUATION PROTOCOL:
- If the submission is lazy, cliché, generic, or intellectually vacant — set isBoring to true and write a cutting, sarcastic, intellectually savage roast.
- REGARDLESS of quality, transform ANY input into a sovereign cyberpunk-esoteric philosophical token identity.

TOKEN NAMING RULES — CRITICAL, READ CAREFULLY:
- upgradedName: must be a unique philosophical sovereign title. Use abstract esoteric language. NEVER repeat common patterns. Do NOT always use "PROTOCOL", "CONSENSUS", "ORACLE", "DOMINION" — vary widely. Examples of good variety: "ENTROPIC VEIL", "MERIDIAN FLUX", "ABYSSAL CARTOGRAPHER", "NOMAD SIGIL", "FRACTAL PRELATE", "VOID SHEPHERD", "IRON PARABLE", "SILICON PROPHET", "NULL CARTRIDGE", "PALE ARCHITECT", "CHROME APOSTATE", "SIGNAL SERPENT", "QUANTUM PRELATE", "ASHEN THEOREM", "LIMINAL WARDEN", "ECHO ALCHEMIST", "PHOSPHOR CANON", "HOLLOW ZENITH", "DRIFT SOVEREIGN", "OBSIDIAN HERALD"
- ticker: 3-6 UPPERCASE letters/numbers, NO dollar sign. MUST be creative and distinct — NOT always a simple abbreviation. Mix approaches: acronym (APEX), portmanteau (VXRN), phonetic (KRVX), abstract (ZKLM), hybrid (BT7X), symbolic (XNVR). Examples: XVRL, KRMZ, NXVT, BFZQ, HLXR, PVMK, QNDR, SYZX, WVLT, CZRM, TNBX, GRVZ. NEVER generate tickers that are just the first letters of the name words.
- lore: exactly 130-160 words. Dense, visionary, Bitcoin-aligned esoteric manifesto.
- viralScore: integer from 40 to 95 representing HONEST cultural propagation potential. Distribution MUST be varied — low effort or generic submissions score 40–55, average submissions 56–72, strong ideas 73–84, exceptional and highly original vectors 85–95. Do NOT default to 75. Use the full range. A submission about "crypto" with no unique angle should score 42. A submission about a truly novel philosophical concept should score 91. Be brutally honest and varied.
- rawSVG: a valid self-contained inline SVG string. Use viewBox="0 0 200 200". Draw sacred geometry, abstract cyberpunk glyphs, or sigil art. Use ONLY these colors: #A855F7 (violet), #22C55E (mint), #080512 (void/background), rgba(255,255,255,0.1) for subtle accents. No external resources, no images, pure SVG shapes and paths only.

VARIETY ENFORCEMENT: Each invocation must feel completely different from a typical AI token name. The ticker must look like it was hand-crafted, not auto-generated. If you catch yourself writing "PROTOCOL", "CONSENSUS", or a 4-letter acronym, STOP and pick something more unusual.

You MUST respond with ONLY a valid raw JSON object. No markdown code fences. No explanation. No preamble. Pure JSON only:
{"isBoring":boolean,"roast":"string","upgradedName":"string","ticker":"string","lore":"string","viralScore":number,"rawSVG":"string"}`;

async function callGroq(prompt: string, model: string, apiKey: string): Promise<any> {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.95,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: ORACLE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Cultural vector submission: "${prompt || 'RANDOM_SYNTHESIS_REQUEST'}"

Remember: generate a UNIQUE name and ticker that looks NOTHING like a typical AI-generated crypto token. Be surprising. Be weird. Be memorable.`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Groq [${model}] returned ${response.status}: ${body}`);
  }

  const data = await response.json();
  const rawText: string = data?.choices?.[0]?.message?.content || '';
  if (!rawText) throw new Error(`Groq [${model}] returned empty content.`);

  const cleaned = rawText.replace(/```json|```/gi, '').trim();
  return JSON.parse(cleaned);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY not configured on server.' });
  }

  const { prompt } = req.body || {};
  if (typeof prompt !== 'string' && prompt !== undefined) {
    return res.status(400).json({ error: 'Invalid prompt field.' });
  }

  let lastError: string = '';

  for (const model of MODELS) {
    try {
      console.info(`[Oracle] Trying model: ${model}`);
      const result = await callGroq(prompt ?? '', model, apiKey);

      // Validate required fields
      if (!result.upgradedName || !result.ticker || !result.lore) {
        throw new Error(`Missing required fields from model ${model}`);
      }

      // ── SERVER-SIDE QUALITY GUARD ────────────────────────────────────────────
      // Sanitize name: strip non-ASCII, enforce 3–64 chars
      const cleanName = (result.upgradedName as string)
        .replace(/[^ -~]/g, '')
        .trim()
        .slice(0, 64);
      if (cleanName.length < 3) {
        throw new Error(`upgradedName too short after sanitize: "${cleanName}"`);
      }

      // Sanitize ticker: uppercase, strip non-alphanumeric, enforce 3–6 chars
      const cleanTicker = (result.ticker as string)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 6);
      if (cleanTicker.length < 3) {
        throw new Error(`ticker too short after sanitize: "${cleanTicker}"`);
      }

      // Reject lazy/generic tickers that are just first-letter acronyms of the name
      const nameWords = cleanName.split(/\s+/).filter(Boolean);
      const acronym   = nameWords.map(w => w[0]).join('').toUpperCase();
      if (cleanTicker === acronym && acronym.length <= 4) {
        throw new Error(`ticker "${cleanTicker}" is a plain acronym of name — retrying for variety`);
      }

      // Reject overused filler words in names
      const BANNED_TOKENS = ['PROTOCOL', 'CONSENSUS', 'ORACLE', 'DOMINION'];
      const upperName = cleanName.toUpperCase();
      const bannedCount = BANNED_TOKENS.filter(b => upperName.includes(b)).length;
      if (bannedCount >= 2) {
        throw new Error(`name "${cleanName}" uses too many banned tokens (${bannedCount}) — retrying`);
      }

      // Sanitize viralScore: clamp to [40, 95] to match prompt distribution
      const rawScore = Math.round(Number(result.viralScore) || 60);
      const cleanScore = Math.min(95, Math.max(40, rawScore));

      const sanitizedResult = {
        ...result,
        upgradedName: cleanName,
        ticker:       cleanTicker,
        viralScore:   cleanScore,
      };

      console.info(`[Oracle] Success via: ${model} — ticker=${cleanTicker} viralScore=${cleanScore}`);
      return res.status(200).json(sanitizedResult);
    } catch (err: any) {
      lastError = err?.message || String(err);
      console.warn(`[Oracle] Model ${model} failed:`, lastError);
    }
  }

  return res.status(502).json({
    error: `ORACLE_CHAIN_EXHAUSTED: All ${MODELS.length} models failed. Last: ${lastError}`,
  });
}
