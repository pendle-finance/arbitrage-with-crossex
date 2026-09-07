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
          950: '#090D18',
          900: '#0F1421',
          850: '#1C2740', // translucent-fill companion; the mock's most-used panel ground
          800: '#151C2B',
          700: '#2B3B55',
          600: '#374B6D',
          500: '#4A628C',
          400: '#5B749D',
          300: '#7B94BD',
          200: '#9DAFCD',
          100: '#BFCBDF',
          50: '#FFFFFF',
        },

        // Semantic — what new code should use.
        grass,
        guava,
        gold,
        info: { DEFAULT: info, light: pastelBlue },
        'pastel-blue': pastelBlue,
        link: '#7AB7FF',

        // Bridge aliases. Delete once call sites are codemodded to the four above.
        // `cyan` was the original app's neutral accent (selected, active,
        // mixed-side). Neutral is BLUE in the Boros system, so it bridges to
        // info; `emerald`/`teal` stay the gain/long green.
        cyan: ramp(info, pastelBlue, '#A8B5FF', '#4A5FD9'),
        emerald: ramp(grass, '#5BEBD3', '#A5F3E5', '#14B89C'),
        teal: ramp(grass, '#5BEBD3', '#A5F3E5', '#14B89C'),
        rose: ramp(guava, '#FFAEAE', '#FFCACA', '#E67878'),
        red: ramp(guava, '#FFAEAE', '#FFCACA', '#E67878'),
        amber: ramp(gold, '#F5DC9A', '#FAEAC4', '#D4B058'),
        yellow: ramp(gold, '#F5DC9A', '#FAEAC4', '#D4B058'),
        orange: ramp(gold, '#F5DC9A', '#FAEAC4', '#D4B058'),
        sky: ramp(info, pastelBlue, '#A8B5FF', '#4A5FD9'),
        blue: ramp(info, pastelBlue, '#A8B5FF', '#4A5FD9'),
        violet: ramp(info, pastelBlue, '#A8B5FF', '#4A5FD9'),
        indigo: ramp(info, pastelBlue, '#A8B5FF', '#4A5FD9'),
      },
      borderRadius: {
        // The mock's three radii. `sm` is tags, `DEFAULT`/`md`/`lg` all collapse
        // to the 5px house radius so existing `rounded-lg` call sites land right,
        // and `xl` is the modal size.
        sm: '2px',
        DEFAULT: '5px',
        md: '5px',
        lg: '5px',
        xl: '10px',
        '2xl': '10px',
      },
    },
  },
  plugins: [],
};
