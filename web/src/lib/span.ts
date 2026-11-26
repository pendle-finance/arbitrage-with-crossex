export function spanText(sec: number): string {
  const hours = Math.floor(sec / 3_600);
  const minutes = Math.floor((sec % 3_600) / 60);
  const seconds = sec % 60;
  const parts = [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', seconds ? `${seconds}s` : ''];
  return parts.filter(Boolean).join(' ') || '0s';
}

export function parseSpan(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (/^\d+$/.test(text)) return Number(text) > 0 ? Number(text) * 60 : null;
  const parts = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/.exec(text);
  if (!parts || (!parts[1] && !parts[2] && !parts[3])) return null;
  const sec = Number(parts[1] ?? 0) * 3_600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0);
  return sec > 0 ? sec : null;
}
