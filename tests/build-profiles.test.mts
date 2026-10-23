import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { appEnvironmentForBuildProfile, buildAppConfig, inspectBuildReadiness } from '../config/build-config.cjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const syntheticApi = 'https://api.translacat.app/api/v1';
const deviceEnvironment = { EAS_BUILD_PROFILE: 'device', EXPO_PUBLIC_APP_ENV: 'development', EXPO_PUBLIC_API_URL: syntheticApi };

function runIsolatedScript(script: string, args: string[], additions: Record<string, string> = {}) {
  // 준비 / 실행: 실제 dotenv·계정 환경을 읽지 않고 실패 gate 또는 읽기 전용 설정 검사만 실행한다.
  return spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    env: { EXPO_NO_DOTENV: '1', NODE_ENV: 'test', ...additions },
    encoding: 'utf8',
    timeout: 60000,
  });
}

test('device APK embeds the bundle while reusing the development EAS environment', () => {
  // 준비: 저장소의 실제 EAS profile과 사용자 실행 명령을 읽는다.
  const eas = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  // 검증: 독립 APK도 개발 자격을 쓰며 기존 세 환경의 의미는 유지한다.
  assert.deepEqual(eas.build.device, {
    developmentClient: false, distribution: 'internal', environment: 'development',
    env: { EXPO_PUBLIC_APP_ENV: 'development' }, android: { buildType: 'apk' },
  });
  assert.equal(manifest.scripts['build:device:android'], 'node scripts/build.mjs device android');
  assert.equal(eas.build.development.developmentClient, true);
  assert.equal(eas.build.preview.environment, 'preview');
  assert.equal(eas.build.preview.android.buildType, 'apk');
  assert.equal(eas.build.production.environment, 'production');
  assert.equal(eas.build.production.android.buildType, 'app-bundle');
});

test('build profile maps separately to the application environment and rejects unsupported targets', () => {
  for (const profile of ['development', 'preview', 'production']) assert.equal(appEnvironmentForBuildProfile(profile, 'android'), profile);
  assert.equal(appEnvironmentForBuildProfile('device', 'android'), 'development');
  assert.throws(() => appEnvironmentForBuildProfile('device', 'ios'), /Android only/);
  assert.throws(() => appEnvironmentForBuildProfile('__proto__', 'android'), /Build profile/);
  assert.throws(() => appEnvironmentForBuildProfile('device', 'windows'), /Platform/);
});

test('device configuration preserves the registered development identity and exposes public connection metadata only', () => {
  // 준비 / 실행: 새 profile 이름이 앱 환경·식별자로 섞이지 않는지 확인한다.
  const config = buildAppConfig({ ...deviceEnvironment, MOBILE_AUTH_APPROVAL_SECRET: 'synthetic-private-marker' });
  const readiness = inspectBuildReadiness({ EXPO_PUBLIC_APP_ENV: 'preview', EXPO_PUBLIC_API_URL: syntheticApi }, { profile: 'device', platform: 'android', cloud: true });

  // 검증: wrapper는 development로 매핑하고 원격 Firebase 자격 검증은 대기 상태로 구분한다.
  assert.equal(config.scheme, 'translacat-dev');
  assert.equal(config.android?.package, 'com.krumichan.translacat.dev');
  assert.equal(config.ios?.bundleIdentifier, 'com.krumichan.translacat.dev');
  assert.equal(config.extra.appEnvironment, 'development');
  assert.equal(config.extra.apiBaseUrl, syntheticApi);
  assert.doesNotMatch(JSON.stringify(config), /synthetic-private-marker/);
  assert.equal(readiness.appEnvironment, 'development');
  assert.deepEqual(readiness.errors, []);
  assert.ok(readiness.waiting.some(message => message.includes('GOOGLE_SERVICES_JSON EAS File variable')));
});

test('device rejects missing APIs, local networks, placeholders, and incomplete REST bases', () => {
  // 준비: 사설망 예외는 기존 Metro 개발에만 남기고 독립 APK에서는 거부한다.
  const rejected = ['', ' ', 'http://localhost:8080/api/v1', 'http://10.0.2.2:8080/api/v1',
    'https://localhost/api/v1', 'https://192.168.1.2/api/v1', 'https://100.64.0.1/api/v1',
    'https://169.254.1.1/api/v1', 'https://192.0.2.1/api/v1', 'https://198.51.100.1/api/v1',
    'https://203.0.113.1/api/v1', 'https://224.0.0.1/api/v1', 'https://[::1]/api/v1',
    'https://[fc00::1]/api/v1', 'https://[fe80::1]/api/v1', 'https://[2001:db8::1]/api/v1',
    'https://api.example.com/api/v1', 'https://api.invalid/api/v1', 'https://single-host/api/v1',
    'https://api.translacat.app', 'https://api.translacat.app/api/v2'];

  // 실행 / 검증: 로컬 사전검사와 원격 app config에 동일한 gate를 적용한다.
  for (const url of rejected) {
    const env = { ...deviceEnvironment, EXPO_PUBLIC_API_URL: url };
    assert.throws(() => buildAppConfig(env), /EXPO_PUBLIC_API_URL/);
    const readiness = inspectBuildReadiness(env, { profile: 'device', platform: 'android', cloud: true });
    assert.ok(readiness.errors.some(error => error.includes('EXPO_PUBLIC_API_URL')));
    assert.throws(() => buildAppConfig({ ...env, EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'android' }), /EXPO_PUBLIC_API_URL/);
  }
});

test('device rejects embedded credentials and callback-like query or fragment without logging their values', () => {
  for (const url of ['https://user:synthetic-private-marker@api.translacat.app/api/v1',
    'https://api.translacat.app/api/v1?token=synthetic-private-marker', 'https://api.translacat.app/api/v1#synthetic-private-marker']) {
    assert.throws(() => buildAppConfig({ ...deviceEnvironment, EXPO_PUBLIC_API_URL: url }), error => {
      assert.match(String(error), /EXPO_PUBLIC_API_URL/);
      assert.doesNotMatch(String(error), /synthetic-private-marker/);
      return true;
    });
  }
});

test('device accepts synthetic public HTTPS host or IP and normalizes a trailing slash', () => {
  for (const url of [syntheticApi + '/', 'https://8.8.8.8/api/v1', 'https://[2606:4700:4700::1111]/api/v1']) {
    // 실행 / 검증: 주소 형태만 검사하며 해당 서버의 존재나 TLS 성공을 주장하지 않는다.
    const config = buildAppConfig({ ...deviceEnvironment, EXPO_PUBLIC_API_URL: url });
    assert.equal(config.extra.apiBaseUrl, url.replace(/\/$/, ''));
  }
});

test('direct EAS device config rejects a different application environment or iOS target', () => {
  for (const environment of ['preview', 'production', 'device']) {
    assert.throws(() => buildAppConfig({ ...deviceEnvironment, EXPO_PUBLIC_APP_ENV: environment }), /device build profile requires EXPO_PUBLIC_APP_ENV=development/);
  }
  assert.throws(() => buildAppConfig({ ...deviceEnvironment, EAS_BUILD_PLATFORM: 'ios' }), /Android only/);
  assert.throws(() => buildAppConfig({ ...deviceEnvironment, EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'android' }), /Android EAS build requires GOOGLE_SERVICES_JSON/);
});

test('existing Metro development keeps optional API and local emulator HTTP behavior', () => {
  const missing = inspectBuildReadiness({}, { profile: 'development', platform: 'android' });
  const local = buildAppConfig({ EXPO_PUBLIC_APP_ENV: 'development', EXPO_PUBLIC_API_URL: 'http://10.0.2.2:8080/api/v1' });
  assert.deepEqual(missing.errors, []);
  assert.ok(missing.waiting.some(message => message.includes('Public API connection is not configured')));
  assert.equal(local.extra.apiBaseUrl, 'http://10.0.2.2:8080/api/v1');
});

test('actual build wrapper stops before EAS for missing device API and unsupported iOS', () => {
  for (const platform of ['android', 'ios']) {
    const result = runIsolatedScript('scripts/build.mjs', ['device', platform]);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, platform === 'android' ? /requires EXPO_PUBLIC_API_URL/ : /Android only/);
    assert.doesNotMatch(result.stdout + result.stderr, /Logging in|Build details|Queued|https:\/\/expo\.dev/);
  }
});

test('actual read-only config command checks device with isolated public fixture and no dotenv', () => {
  const args = ['--cloud', '--profile', 'device', '--platform', 'android'];
  const missing = runIsolatedScript('scripts/check-config.mjs', args);
  const configured = runIsolatedScript('scripts/check-config.mjs', args, { EXPO_PUBLIC_API_URL: syntheticApi, EXPO_PUBLIC_APP_ENV: 'preview' });
  assert.ifError(missing.error);
  assert.ifError(configured.error);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires EXPO_PUBLIC_API_URL/);
  assert.equal(configured.status, 0);
  assert.match(configured.stdout, /App environment: development/);
  assert.match(configured.stdout, /GOOGLE_SERVICES_JSON EAS File variable/);
  assert.doesNotMatch(configured.stdout + configured.stderr, /https:\/\/api\.translacat\.app/);
});
