export const formatTimecode = (sec: number): string => {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = (s % 60).toFixed(1).padStart(4, "0");
  return `${m}:${rem}`;
};
