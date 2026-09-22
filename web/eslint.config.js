// Lint for web/. Run: npm run lint   (npm run lint -- --fix for the autofixes)
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // src/vendor/** is third-party code kept byte for byte (src/vendor/cubejs/README.md):
  // linting it would only ever ask us to edit what must not be edited.
  { ignores: ['dist/**', 'public/**', 'node_modules/**', 'src/vendor/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // the codebase names intentionally-unused args and catch bindings with _
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // ORT tensors and DOM globals come through as any at the boundaries
      '@typescript-eslint/no-explicit-any': 'off',
      // `while (true)` loops with a break are used in the frame pump
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
);
