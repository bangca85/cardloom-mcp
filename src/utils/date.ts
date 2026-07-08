const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function daysSince(isoDate: string, now: Date): number {
  const time = new Date(isoDate).getTime();
  if (isNaN(time)) return Infinity;
  const nowTime = now.getTime();
  if (isNaN(nowTime)) return Infinity;
  return (nowTime - time) / MS_PER_DAY;
}
