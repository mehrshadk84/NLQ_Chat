/**
 * Optional lightweight Web Search helper for "analysis" intent when the user asks to
 * compare ERP metrics against an external company, market, or website.
 */
export function needsWebComparison(q: string): boolean {
  return /(نسبت به شرکت|در مقایسه با شرکت|سایت|بازار|رقبا|رقیب|اینترنت|وب|همکاران سیستم|سپیدار|چارگون)/.test(q);
}

export async function fetchExternalWebContext(q: string, signal?: AbortSignal): Promise<string> {
  if (!needsWebComparison(q)) return '';
  try {
    const cleanQ = q.replace(/[^\u0600-\u06FFa-zA-Z0-9\s]/g, ' ').trim();
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQ)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GreenXERP-Analyst/1.0)' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3500)]) : AbortSignal.timeout(3500),
    });
    if (!res.ok) return '';
    const html = await res.text();
    const snippets = [...html.matchAll(/class="result__snippet[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 20)
      .slice(0, 3);
    return snippets.length > 0 ? `\n[اطلاعات وب جهت مقایسه]:\n- ${snippets.join('\n- ')}` : '';
  } catch {
    return '';
  }
}
