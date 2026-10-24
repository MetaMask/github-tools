module.exports = {
  root: true,

  extends: ['@metamask/eslint-config'],

  overrides: [
    {
      files: ['*.ts', '*.mts'],
      extends: ['@metamask/eslint-config-typescript'],
    },

    {
      files: ['*.js', '*.ts', '*.mts'],
      parserOptions: {
        sourceType: 'script',
      },
      extends: ['@metamask/eslint-config-nodejs'],
    },

    {
      files: ['*.mjs', '*.mts'],
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 2022,
      },
      extends: ['@metamask/eslint-config-nodejs'],
      rules: {
        'import/extensions': 'off',
      },
    },

    {
      files: ['*.test.ts', '*.test.js'],
      extends: ['@metamask/eslint-config-jest'],
    },

    {
      files: ['.github/scripts/**/*.mts'],
      parserOptions: {
        project: './tsconfig.json',
      },
    },

    {
      files: ['.github/scripts/**/*.test.mts'],
      rules: {
        '@typescript-eslint/no-floating-promises': 'off',
        'n/no-process-env': 'off',
      },
    },
  ],

  ignorePatterns: [
    '!.eslintrc.js',
    '!.prettierrc.js',
    '.yarn/',
    'dist/',
    'docs/',
    'tmp/',
  ],
};
