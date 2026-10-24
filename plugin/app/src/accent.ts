// The accent colours link text as well as the selected tab and focus ring, so it needs 4.5:1 on the
// panel's white. WordPress 7.1's admin colour schemes all meet that; some earlier ones do not (7.0's
// Sunrise is 2.9:1), and those are darkened just enough, keeping their hue.
const MAX_LUMINANCE = 1.05 / 4.5 - 0.05;

const toLinear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const toChannel = (c: number) => Math.floor(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));

/** A computed `rgb()` colour, darkened when it is under 4.5:1 on white; any other colour as it is. */
export function readableOnWhite(color: string): string {
  if (!color.startsWith("rgb")) return color;
  const linear = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((channel) => toLinear(Number(channel)));
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  if (luminance <= MAX_LUMINANCE) return color;
  // Scaling linear light scales luminance by the same factor; rounding down only darkens further.
  const [r, g, b] = linear.map((c) => toChannel((c * MAX_LUMINANCE) / luminance));
  return `rgb(${r}, ${g}, ${b})`;
}
