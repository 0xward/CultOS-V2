/**
 * CultOS Oracle Service — Client-side proxy to /api/oracle
 *
 * All Groq API calls are made server-side via the Vercel serverless function.
 * GROQ_API_KEY is never exposed to the client bundle.
 */

export interface OracleVerdict {
  isBoring: boolean;
  roast: string;
  upgradedName: string;
  ticker: string;
  lore: string;
  viralScore: number;
  rawSVG: string;
}

export async function invokeOracle(userPrompt: string): Promise<OracleVerdict> {
  const response = await fetch('/api/oracle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: userPrompt }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error || `Oracle API returned ${response.status}`);
  }

  return data as OracleVerdict;
}
