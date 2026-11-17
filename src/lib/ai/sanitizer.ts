/**
 * ماژول ماسک‌گذاری و محافظت از داده‌های محرمانه تجاری
 */
export function maskEntityName(name: string): string {
  if (!name || typeof name !== 'string') return name;
  const clean = name.trim();
  if (clean.length <= 4) return 'شرکت ***';
  
  // حفظ دو کلمه/حرف اول و ماسک مابقی کاراکترها
  const parts = clean.split(/\s+/);
  if (parts.length > 1) {
    return `${parts[0]} ${parts[1].slice(0, 1)}***`;
  }
  return `${clean.slice(0, 4)}***`;
}

export function maskEntityClearanceResults(records: Array<{ id: number | string; value: string }>): Array<{ id: number | string; value: string }> {
  return records.map((r, idx) => ({
    id: r.id,
    value: maskEntityName(r.value) || `مشتری/شرکت ${idx + 1}`,
  }));
}

export function maskSensitiveRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const sensitiveKeys = ['customer', 'customername', 'person', 'personname', 'company', 'companyname', 'value'];
  return rows.map((row) => {
    const masked: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      const lowerKey = k.toLowerCase();
      if (sensitiveKeys.some((s) => lowerKey.includes(s)) && typeof v === 'string') {
        masked[k] = maskEntityName(v);
      } else {
        masked[k] = v;
      }
    }
    return masked;
  });
}
