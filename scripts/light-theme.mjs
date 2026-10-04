/**
 * PostCSS plugin: derives the light theme from the dark stylesheet.
 *
 * src/style.css is written for the dark theme. For every rule that sets a colour this plugin appends a
 * copy scoped to `:root[data-theme="light"]` with each colour re-mapped for a light background:
 *  - greys and dark tints: lightness flipped on a curve (page/panels → near-white, borders → light grey,
 *    text → near-black), hue and saturation kept, so tinted chips stay tinted;
 *  - vivid colours (accent, good/warn/bad, team and brand colours) are kept;
 *  - pure black/white and translucent black (video background, scrims, overlays on video) are kept;
 *    faint translucent white (hairlines on dark) becomes the same faint black.
 * Every colour declaration of a rule is copied, mapped or not, so the cascade between rules is the same
 * in both themes. The dark theme is untouched. Hand-tuned tokens in `LIGHT_TOKENS` win over the mapping.
 */

const COLOR_PROPS = /^(color|background(-color|-image)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration(-color)?|scrollbar-color|column-rule(-color)?|--.*)$/;
const HEX = /#([0-9a-fA-F]{3,8})\b/g;
const PREFIX = ':root[data-theme="light"]';

/** Hand-picked light values for the core tokens (the mapping alone makes panels grey instead of white). */
export const LIGHT_TOKENS = {
  '--bg': '#f3f4f7',
  '--bg2': '#fbfbfc',
  '--panel': '#ffffff',
  '--panel2': '#f5f6f8',
  '--line': '#e3e6eb',
  '--line2': '#d3d8e0',
  '--text': '#15181e',
  '--muted': '#5f6672',
  '--dim': '#8b919c',
  '--good': '#16a34a',
  '--warn': '#c27c0e',
  '--bad': '#dc2626',
  'color-scheme': 'light',
};

function parseHex(h) {
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return undefined;
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

function toHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h / 6, s, l };
}

function fromHsl({ h, s, l }) {
  const f = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: f(p, q, h + 1 / 3) * 255, g: f(p, q, h) * 255, b: f(p, q, h - 1 / 3) * 255 };
}

const hex2 = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
const toHex = ({ r, g, b }, a) => `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ''}`;

/** Dark-theme lightness → light-theme lightness. */
function flip(l) {
  if (l <= 0.13) return 1 - l * 0.35; // page, panels, fields → near-white
  if (l <= 0.3) return 0.955 - (l - 0.13) * 1.2; // hovers, borders → light greys
  return 0.75 - ((l - 0.3) / 0.7) * 0.67; // muted → mid grey, text → near-black
}

/** Map one dark-theme colour to its light-theme colour (exported for tests). */
export function lightColor(hex) {
  const c = parseHex(hex.replace('#', ''));
  if (!c) return hex;
  const hsl = toHsl(c);
  const pureBlack = c.r + c.g + c.b === 0;
  const pureWhite = c.r + c.g + c.b === 765;
  if (pureBlack || pureWhite) {
    if (pureWhite && c.a < 0.5) return toHex({ r: 0, g: 0, b: 0 }, c.a * 0.8); // hairline on dark → hairline on light
    return hex;
  }
  if (c.a < 1 && hsl.l < 0.01) return hex; // translucent black: scrims and overlays on video
  if (hsl.s > 0.45 && hsl.l >= 0.35 && hsl.l <= 0.68) return hex; // vivid: accent, status, brand colours
  if (c.a < 0.5 && hsl.l > 0.9) return toHex({ r: 0, g: 0, b: 0 }, c.a * 0.8);
  return toHex(fromHsl({ ...hsl, l: flip(hsl.l) }), c.a);
}

const mapValue = (v) => v.replace(HEX, (m) => lightColor(m));

function prefixSelector(sel) {
  return sel.split(',').map((s) => {
    s = s.trim();
    if (s === ':root' || s === 'html') return PREFIX;
    if (s.startsWith(':root')) return PREFIX + s.slice(5);
    if (s.startsWith('html')) return PREFIX + s.slice(4);
    return `${PREFIX} ${s}`;
  }).join(', ');
}

export default function lightTheme() {
  return {
    postcssPlugin: 'dial-light-theme',
    Once(root, { Rule, Declaration }) {
      if (!root.source?.input?.file?.replace(/\\/g, '/').endsWith('src/style.css')) return;
      const out = [];
      root.walkRules((rule) => {
        if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
        const decls = rule.nodes.filter((n) => n.type === 'decl' && COLOR_PROPS.test(n.prop));
        if (!decls.length) return;
        const copy = new Rule({ selector: prefixSelector(rule.selector) });
        for (const d of decls) copy.append(new Declaration({ prop: d.prop, value: mapValue(d.value), important: d.important }));
        out.push({ copy, parent: rule.parent });
      });
      // Append after everything, inside the same @media (if any), keeping source order.
      for (const { copy, parent } of out) {
        if (parent.type === 'root') root.append(copy);
        else {
          const wrap = parent.clone({ nodes: [] });
          wrap.append(copy);
          root.append(wrap);
        }
      }
      const tokens = new Rule({ selector: PREFIX });
      for (const [prop, value] of Object.entries(LIGHT_TOKENS)) tokens.append(new Declaration({ prop, value }));
      root.append(tokens);
    },
  };
}
lightTheme.postcss = true;
