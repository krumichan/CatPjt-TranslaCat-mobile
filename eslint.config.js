const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

// Expo 기본 설정이 제외하는 Node TS 테스트와 CJS 선언에도 같은 TS 규칙을 적용한다.
const typedConfig = expoConfig.find((entry) => entry.files?.includes('**/*.ts') && entry.languageOptions?.parser);

module.exports = defineConfig([
  expoConfig,
  { ...typedConfig, files: ['**/*.mts', '**/*.cts'] },
  { ignores: ['dist/**', 'web-build/**', 'coverage/**', '.expo/**'] },
]);
