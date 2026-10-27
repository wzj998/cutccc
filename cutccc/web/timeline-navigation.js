export function stepFrameTime(position, direction, duration, fps = 30) {
  // Media currentTime is rounded to microseconds; do not get stuck one microsecond before a frame boundary.
  const frame = direction < 0 ? Math.ceil(position * fps - 1e-4) - 1 : Math.floor(position * fps + 1e-4) + 1;
  return Math.max(0, Math.min(duration, frame / fps));
}
export function followScrollLeft(position, zoom, left, width, scrollWidth) {
  if (width <= 0 || zoom <= 0) return left;
  const x = position * zoom;
  if (x >= left && x < left + width - 1) return left;
  return Math.max(0, Math.min(Math.max(0, scrollWidth - width), x - width * .25));
}
