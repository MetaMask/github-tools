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
