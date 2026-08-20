module.exports = {
  env: {
    browser: true,
    es2022: true,
    node: true,
    worker: true
  },
  extends: [
    'eslint:recommended'
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  rules: {
    'indent': ['error', 2],
    'linebreak-style': ['error', 'unix'],
    'quotes': ['error', 'single', { avoidEscape: true }],
    'semi': ['error', 'always'],
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'no-console': ['warn', { allow: ['warn', 'error', 'log'] }],
    'prefer-const': 'error',
    'no-var': 'error',
    'object-shorthand': 'error',
    'prefer-arrow-callback': 'error',
    'arrow-spacing': 'error',
    'no-duplicate-imports': 'error',
    'no-unreachable': 'error',
    'no-constant-condition': 'warn',
    'eqeqeq': ['error', 'always', { null: 'ignore' }],
    'curly': ['error', 'all'],
    'block-scoped-var': 'error',
    'no-undef': 'error',
    'no-shadow': 'warn'
  },
  overrides: [
    {
      files: ['frontend/**/*.js'],
      env: {
        browser: true,
        es2022: true
      },
      globals: {
        localStorage: 'readonly',
        fetch: 'readonly',
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        crypto: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        IntersectionObserver: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        FormData: 'readonly',
        FileReader: 'readonly',
        Image: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        crypto: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Uint8Array: 'readonly',
        JSON: 'readonly',
        Promise: 'readonly',
        Map: 'readonly',
        Set: 'readonly',
        Array: 'readonly',
        Object: 'readonly',
        String: 'readonly',
        Number: 'readonly',
        Date: 'readonly',
        RegExp: 'readonly',
        Error: 'readonly',
        Math: 'readonly',
        isNaN: 'readonly',
        parseInt: 'readonly',
        parseFloat: 'readonly',
        encodeURIComponent: 'readonly',
        decodeURIComponent: 'readonly',
        Intl: 'readonly',
        performance: 'readonly'
      }
    },
    {
      files: ['services/**/*.js', 'gateway/**/*.js'],
      env: {
        worker: true,
        es2022: true
      },
      globals: {
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        crypto: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Uint8Array: 'readonly',
        JSON: 'readonly',
        Promise: 'readonly',
        Map: 'readonly',
        Set: 'readonly',
        Array: 'readonly',
        Object: 'readonly',
        String: 'readonly',
        Number: 'readonly',
        Date: 'readonly',
        RegExp: 'readonly',
        Error: 'readonly',
        Math: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly'
      }
    }
  ],
  ignorePatterns: [
    'node_modules/',
    '.wrangler/',
    'dist/',
    'build/',
    '.github/',
    'docs/',
    'scripts/',
    '*.min.js'
  ]
};