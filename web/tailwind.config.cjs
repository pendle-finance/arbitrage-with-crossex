/** Tailwind config — Boros "water" ramp carried on the house `ink` names, so the
 * palette re-points without any component having to change. Inter only: the mock
 * is a single typeface with tabular numerals, not a sans/mono pair.
 *
 * The accent scales below are DELIBERATE overrides of Tailwind's own cyan /
 * emerald / rose / amber / orange. The app has ~600 call sites across 26 shades;
 * re-pointing the scales moves all of them at once and keeps this a pure token
 * commit. The semantic names (grass/guava/gold/info) are the ones new code should
 * use — the overrides are a bridge, to be codemodded away and deleted. */

/** Semantic four, from the Boros design system. */
const grass = '#1BE3C2'; // long / positive / APR
const guava = '#FF9393'; // short / negative
const gold = '#F0CE74'; // fixed rate, warnings
const info = '#6079FF'; // selection, actions, links
const pastelBlue = '#8396FF'; // hover / lifted variant of info

/** One accent, spread across the shade numbers the app already asks for. The
 * ramp is tinted toward the page ground at the dark end and toward white at the
 * light end, so `-200` reads as "brighter" and `-600` as "deeper" exactly as the
 * Tailwind scales they replace did. */
const ramp = (base, light, lighter, dark) => ({
  100: lighter,
  200: lighter,
  300: light,
  400: base,
  500: base,
  600: dark,
});

module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        ink: {
          // The mockup's `water` ramp, verbatim. 950 is the page ground
          // (--water-900), 900/850 are the opaque card grounds it uses for
          // popovers and menus, 800/700 are its two hairline weights.
          950: '#090D18',
          900: '#0F1421',
          850: '#1C212D', // surface-water-opaque — the mock's opaque popover/menu card
          800: '#1A2537', // --water-850
          700: '#374B6D', // --water-700 — the mock's standard card hairline
          // 400/500 carry 10–12px text and sit at ≥4.5:1 on ink-900/950;
          // 600 is placeholders and separators (≥3:1). Lifted 2026-09-09 —
          // the old values measured 3.9 / 3.0 / 2.1, and the floor is kept
          // here: the mock's own --water-500 (#5B749D) and --water-600
          // (#415981) measure 3.88 and 2.60 on ink-900, so 500/600 take the
          // nearest hue-matched shades that still clear 4.5 / 3.0 rather
          // than the raw ramp values. 400 and up ARE the mock's, verbatim.
          600: '#48638F', // --water-600 lifted to 3.0:1
          500: '#667FA7', // --water-500 lifted to 4.5:1
          400: '#7B94BD', // --water-400
          300: '#9DAFCD', // --water-300-ish; the mock's table-header grey
          200: '#BFC8DF', // --water-200
          100: '#DAE1EC', // --water-100
          50: '#FFFFFF',
        },

        // Semantic — what new code should use.
        // The mock's translucent surface colour (rgb 191 203 223): every water/5,
        // water/10 fill and faint hairline is an alpha of THIS, not of ink-100.
        wash: '#BFCBDF',
        grass,
        guava,
        gold,
        // dapp-nitro's `warning` — the amber the mock uses for a caution tag,
        // a shade deeper than `gold` (which is the fixed-rate colour).
        warning: '#EFB54B',
        info: { DEFAULT: info, light: pastelBlue },
        'pastel-blue': pastelBlue,
        link: '#7AB7FF',
        // dapp-nitro's `crossex` accent — the one colour that means "via
        // CrossEx" there, distinct from the info blue that every other blue
        // tone in this file bridges to.
        crossex: '#4BE7FF',

        // Bridge aliases. Delete once call sites are codemodded to the four above.
        // `cyan` was the original app's neutral accent (selected, active,
        // mixed-side). Neutral is BLUE in the Boros system, so it bridges to
        // info; `emerald` stays the gain/long green.
        cyan: ramp(info, pastelBlue, '#A8B5FF', '#4A5FD9'),
        emerald: ramp(grass, '#5BEBD3', '#A5F3E5', '#14B89C'),
        rose: ramp(guava, '#FFAEAE', '#FFCACA', '#E67878'),
        amber: ramp(gold, '#F5DC9A', '#FAEAC4', '#D4B058'),
        sky: ramp(info, pastelBlue, '#A8B5FF', '#4A5FD9'),
      },
      borderRadius: {
        // The mock's three radii. `sm` is tags (2px), `DEFAULT`/`md`/`lg` all
        // collapse to the 5px house radius so existing `rounded-lg` call sites
        // land right, and `xl` is the 10px modal/`rounded-lg` card size.
        sm: '2px',
        DEFAULT: '5px',
        md: '5px',
        lg: '5px',
        xl: '10px',
      },
      fontSize: {
        // dapp-nitro's scale, with its line heights. The app's bracket sizes
        // (text-[12.5px] etc.) stay valid; these are what new code reaches for.
        'pp-sm': ['10px', '12.1px'],
        'pp-sm2': ['11px', '13.31px'],
        'pp-base': ['12px', '14.52px'],
        'pp-md': ['14px', '16.94px'],
        'pp-md2': ['16px', '19.36px'],
        'pp-lg': ['18px', '1.2'],
        'pp-xl': ['20px', '24.2px'],
        'pp-2xl': ['24px', '29.05px'],
        'pp-3xl': ['28px', '1.1'],
      },
    },
  },
  plugins: [],
};
