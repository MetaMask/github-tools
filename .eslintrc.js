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
      files: ['*.test.ts', '*.test.mts', '*.test.js'],
      extends: ['@metamask/eslint-config-jest'],
    },

    {
      files: ['.github/scripts/**/*.mts'],
      parserOptions: {
        project: './tsconfig.release-changelog.json',
        sourceType: 'module',
      },
      rules: {
        'jsdoc/require-jsdoc': 'off',
        'n/no-process-env': 'off',
      },
    },

    {
      files: ['.github/scripts/**/*.test.mts'],
      rules: {
        '@typescript-eslint/no-floating-promises': 'off',
        '@typescript-eslint/no-shadow': 'off',
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
