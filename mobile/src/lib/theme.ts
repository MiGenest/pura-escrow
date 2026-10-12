import type { ImageSourcePropType } from 'react-native';

/**
 * Design tokens for the native app.
 *
 * Source of truth is solana/app/src/App.css — NOT the Figma file directly.
 * That is deliberate, and App.css's own `--pura-*` block explains why: the
 * Figma design system's palette (saturated blue/neutral grey) differs from
 * what ships today (teal/aqua), and it carries no dark-theme variants. The
 * decision on record is to take Figma's NAMING and SCALE as the reference
 * while keeping the colours that are actually live. Pulling Figma's raw hex
 * in here would silently re-theme the native app away from the web one.
 *
 * So: `colors` mirrors App.css's `:root` palette, and `space`/`radius`/`font`
 * mirror its already-reconciled `--pura-*` layer. Extend from that block
 * rather than inventing values, so the two clients cannot drift.
 */

/** Raw palette — App.css `:root`. */
export const colors = {
  bg: '#EFF7F6',
  card: '#FFFFFF',
  field: '#EAF7F6',
  border: '#D8EEEC',
  primary: '#7BDFF2',
  primaryDark: '#2FA8C4',
  primaryDeep: '#1F7F95',
  primarySoft: '#B2F7EF',
  danger: '#C2564A',
  text: '#234A54',
  textMuted: '#6C9199',
  textFaint: '#9FBEC3',
  onPrimary: '#12414C',
  /* Derived from `danger` at 12%, and the one value here App.css has no
     counterpart for. The web client signals a failed action with danger TEXT
     and a danger border, which reads fine in a desktop column — on a phone,
     inside a sheet the user is mid-tap on, it reads as ordinary small print
     and gets missed. Observed on device 2026-09-18: a failed accept showed
     its error, the error was not registered, and the load was tapped again.
     So the native confirm sheets fill the block as well as outline it. */
  dangerSoft: 'rgba(194, 86, 74, 0.12)',
} as const;

/**
 * Semantic aliases — App.css's `--pura-*` layer, same mapping.
 *
 * CAVEAT, carried over verbatim from that file: `actionPrimary` and
 * `bgBrand` are approximations. Figma's action-primary/bg-brand both host
 * white text, which is the reverse of this app's own primary button (light
 * background, dark text). There is no exact equivalent in the current
 * palette, so these alias to the closest same-hue values dark enough to
 * actually carry white — pending real design work settling a button
 * treatment for that pairing. Do not treat them as final.
 */
export const semantic = {
  bgCanvas: colors.bg,
  bgSurface: colors.card,
  bgSubtle: colors.field,
  borderDefault: colors.border,
  textPrimary: colors.text,
  textSecondary: colors.textMuted,
  textTertiary: colors.textFaint,
  textInverse: '#FFFFFF',
  actionPrimary: colors.primaryDeep, // approximation — see above
  bgBrand: colors.primaryDark, // approximation — see above
  bgBrandStrong: colors.primaryDeep, // approximation — see above
  bgDanger: colors.dangerSoft,
  borderDanger: colors.danger,
  textDanger: colors.danger,
} as const;

/** `--pura-space-*`. */
export const space = {
  s0: 0,
  s4: 4,
  s8: 8,
  s12: 12,
  s16: 16,
  s20: 20,
  s24: 24,
} as const;

/**
 * `--pura-radius-*`, deliberately NOT named `sm`/`md`/`lg` on its own.
 *
 * App.css carries two different radius scales: its original `--r-*`
 * (sm=12 / md=16 / lg=20 / xl=26) and the Figma-derived `--pura-radius-*`
 * (sm=8 / md=12 / xl=20, no "lg"). The names collide while the values do
 * not, and unifying them would silently shrink every existing "sm" corner.
 * This exports the pura scale under an unambiguous key so a reader can
 * never mistake `radius.pura12` for `--r-md`.
 */
export const radius = {
  pura8: 8,
  pura12: 12,
  pura20: 20,
  puraPill: 999,
} as const;

/**
 * `--font-display` / `--font-body` / `--font-mono`.
 *
 * The Noto Sans Georgian fallback is load-bearing, not decoration: none of
 * Space Grotesk, Inter or IBM Plex Mono carries a single Georgian glyph, so
 * without it Georgian text falls through to the system sans — or to tofu on
 * a device with no Georgian face. React Native takes a single family name
 * rather than a CSS stack, so the fallback is expressed per-platform by the
 * OS; these names are what a future custom-font load must register as.
 */
export const font = {
  display: 'Space Grotesk',
  body: 'Inter',
  mono: 'IBM Plex Mono',
} as const;

/**
 * Type scale. App.css has no named scale — it uses rem values inline — so
 * these are the sizes screen 1 already settled on, named, at the 16px root
 * the web app assumes. Extend by adding a step here rather than hardcoding
 * a number in a screen.
 */
export const type = {
  title: 26,
  subtitle: 15,
  body: 16,
  label: 14,
  caption: 13,
  footnote: 12,
} as const;

/**
 * The Keystone mark, BUNDLED — not fetched.
 *
 * This was a remote R2 URL, which put a network request in front of the very
 * first thing a user sees: on a cold start with poor connectivity the login
 * screen rendered with a hole where the brand should be. A demo on venue wifi
 * is exactly the situation that fails, and the fix costs 16 KB.
 *
 * The asset is generated from the committed Keystone SVG by
 * scripts/make-brand-assets.py, so the geometry has a reviewable source
 * rather than being an opaque binary.
 *
 * Typed loosely because Metro resolves require() of an image to an asset
 * registry id (a number), while the same call under tsc's node resolution is
 * typed `any`; ImageSourcePropType accepts both.
 */
export const LOGO_SOURCE: ImageSourcePropType = require('@/assets/images/keystone-logo.png');
