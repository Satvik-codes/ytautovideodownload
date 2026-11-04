/** 75 -> "1:15", 3675 -> "1:01:15" */
export function formatClock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Accepts "75", "1:15" or "0:01:15"; returns whole seconds or null. */
export function parseClock(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  if (parts.slice(1).some((p) => Number(p) >= 60)) return null;
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}
