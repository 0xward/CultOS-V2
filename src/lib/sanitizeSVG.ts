/**
 * SVG Sanitizer — strips dangerous constructs before dangerouslySetInnerHTML.
 * Uses regex-based approach (no external dependency needed).
 * Removes: <script>, on* handlers, javascript: URIs, data: URIs, foreignObject.
 */
export function sanitizeSVG(rawSVG: string): string {
  if (!rawSVG || typeof rawSVG !== 'string') return '';
  return rawSVG
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\s+on\w+\s*=\s*[^\s>]*/gi, '')
    .replace(/href\s*=\s*["']?\s*javascript:[^"'\s>]*/gi, '')
    .replace(/(href|src|xlink:href)\s*=\s*["']?\s*data:[^"'\s>]*/gi, '')
    .replace(/<use[^>]+href\s*=\s*["']https?:\/\/[^"'>]*["'][^>]*>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '');
}
