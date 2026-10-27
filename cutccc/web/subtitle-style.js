// Shared by the browser preview and Node.js export; font sizes use a 1080-high canvas.
export const DEFAULT_STYLE = Object.freeze({
  fontFamily: "Microsoft YaHei", fontSize: 40, color: "#ffffff",
  bold: true, italic: false, outlineColor: "#000000", outlineWidth: 2,
  position: "bottom-center", marginX: 6, marginY: 12,
});
export const FONTS = ["Microsoft YaHei", "Noto Sans CJK SC", "Arial"];
export const POSITIONS = [
  "bottom-left", "bottom-center", "bottom-right",
  "middle-left", "middle-center", "middle-right",
  "top-left", "top-center", "top-right",
];
export function validateStyle(style) {
  if (style === undefined) return;
  if (!style || typeof style !== "object" || Array.isArray(style))
    throw new Error("Subtitle style must be an object");
  for (const [key, value] of Object.entries(style)) {
    if (!Object.hasOwn(DEFAULT_STYLE, key)) throw new Error(`Unknown subtitle style: ${key}`);
    if (key === "fontFamily" && !FONTS.includes(value)) throw new Error("Unsupported subtitle font");
    if (key === "position" && !POSITIONS.includes(value)) throw new Error("Invalid subtitle position");
    if (["bold", "italic"].includes(key) && typeof value !== "boolean") throw new Error("Subtitle emphasis must be boolean");
    if (["color", "outlineColor"].includes(key) && (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)))
      throw new Error("Subtitle colors must be #RRGGBB");
    const range = {fontSize: [12, 96], outlineWidth: [0, 8], marginX: [0, 40], marginY: [0, 40]}[key];
    if (range && (typeof value !== "number" || !Number.isFinite(value) || value < range[0] || value > range[1]))
      throw new Error(`Subtitle ${key} must be between ${range[0]} and ${range[1]}`);
  }
}
export function resolvedStyle(style) {
  validateStyle(style);
  return {...DEFAULT_STYLE, ...style};
}
export function subtitleLayout(style, width, height) {
  const s = resolvedStyle(style);
  const [vertical, horizontal] = s.position.split("-");
  const anchorX = {left: 0, center: .5, right: 1}[horizontal];
  const anchorY = {top: 0, middle: .5, bottom: 1}[vertical];
  return {
    ...s, anchorX, anchorY, alignment: POSITIONS.indexOf(s.position) + 1,
    x: horizontal === "center" ? width / 2 : width * (horizontal === "left" ? s.marginX / 100 : 1 - s.marginX / 100),
    y: vertical === "middle" ? height / 2 : height * (vertical === "top" ? s.marginY / 100 : 1 - s.marginY / 100),
    fontPixels: s.fontSize * height / 1080,
    outlinePixels: s.outlineWidth * height / 1080,
    textAlign: horizontal, maxWidth: width * (1 - s.marginX / 50),
  };
}
