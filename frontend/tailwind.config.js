/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        gold: {
          50:  '#FFFBEB',
          100: '#FEF3C7',
          200: '#FDE68A',
          300: '#FCD34D',
          400: '#FBBF24',
          500: '#F59E0B',
          600: '#D97706',
          700: '#B45309',
          800: '#92400E',
          900: '#78350F',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
      },
      animation: {
        'fade-in':   'fadeIn 0.15s ease-out',
        'slide-up':  'slideUp 0.25s ease-out',
        'slide-down': 'slideDown 0.25s ease-out',
        'progress':  'progress 1.5s ease-in-out infinite',
      },
      keyframes: {
        fadeIn:    { '0%': { opacity: '0' },                              '100%': { opacity: '1' } },
        slideUp:   { '0%': { transform: 'translateY(20px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } },
        slideDown: { '0%': { transform: 'translateY(-10px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } },
        progress:  { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(400%)' } },
      },
    },
  },
  plugins: [],
}
