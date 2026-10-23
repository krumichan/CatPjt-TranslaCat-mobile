import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAppConfig, inspectBuildReadiness } from '../config/build-config.cjs';

const productionEnvironment = {
  EXPO_PUBLIC_APP_ENV: 'production',
  EXPO_PUBLIC_API_URL: 'https://api.translacat.app/api/v1',
  EXPO_OWNER: 'test-owner',
  EXPO_PROJECT_ID: '123e4567-e89b-42d3-a456-426614174000',
  TRANSLACAT_ANDROID_PACKAGE: 'com.translacat.app',
  TRANSLACAT_IOS_BUNDLE_IDENTIFIER: 'com.translacat.app',
};

test('local defaults use the verified project without pretending to have a server connection', () => {
  // 준비 / 실행: 확인된 공개 프로젝트 링크를 쓰되 API는 아직 연결하지 않는다.
  const config = buildAppConfig({});
  const readiness = inspectBuildReadiness({});

  // 검증: 개발 환경은 실행 가능하며 외부 연결은 명시적으로 대기한다.
  assert.equal(config.slug, 'translacat-mobile');
  assert.equal(config.scheme, 'translacat-dev');
  assert.equal(config.android?.package, 'com.krumichan.translacat.dev');
  assert.equal(config.extra.apiBaseUrl, undefined);
  assert.equal(config.owner, 'kurumichans-team');
  assert.equal(config.extra.eas?.projectId, '55b79b33-07b9-4d4b-a3f8-cf24ea76b139');
  assert.deepEqual(readiness.errors, []);
  assert.ok(readiness.waiting.some((message) => message.includes('Public API')));
});

test('preview separates identifiers and URL scheme from development and production', () => {
  const config = buildAppConfig({ EXPO_PUBLIC_APP_ENV: 'preview' });
  assert.equal(config.android?.package, 'com.krumichan.translacat.preview');
  assert.equal(config.ios?.bundleIdentifier, 'com.krumichan.translacat.preview');
  assert.equal(config.scheme, 'translacat-preview');
});

test('production cannot silently fall back to local defaults', () => {
  assert.throws(() => buildAppConfig({ EXPO_PUBLIC_APP_ENV: 'production' }), /Production requires EXPO_PUBLIC_API_URL/);
  for (const key of ['TRANSLACAT_ANDROID_PACKAGE', 'TRANSLACAT_IOS_BUNDLE_IDENTIFIER', 'EXPO_PUBLIC_API_URL']) {
    // 준비: production의 필수 설정을 한 항목씩 제거한다.
    const env = { ...productionEnvironment, [key]: '' };

    // 실행 / 검증: 다른 설정이 있어도 누락 항목을 가짜 값으로 보완하지 않는다.
    assert.throws(() => buildAppConfig(env), new RegExp(key));
  }
});

test('production accepts explicit configuration and exposes only public allowlisted extras', () => {
  // 준비: 서버 비밀값이 같은 프로세스 환경에 있어도 클라이언트 extra로 복사하면 안 된다.
  const config = buildAppConfig({
    ...productionEnvironment,
    GOOGLE_CLIENT_SECRET: 'server-secret-marker',
    EXPO_ACCESS_TOKEN: 'server-token-marker',
    EXPO_PUBLIC_UNEXPECTED_SECRET: 'unexpected-marker',
  });

  // 실행 / 검증: extra 필드를 직접 허용하고 비밀값의 존재를 공개 결과에 반영하지 않는다.
  assert.equal(config.scheme, 'translacat');
  assert.deepEqual(Object.keys(config.extra).sort(), ['apiBaseUrl', 'appEnvironment', 'eas']);
  assert.equal(config.extra.eas?.projectId, productionEnvironment.EXPO_PROJECT_ID);
  assert.doesNotMatch(JSON.stringify(config), /secret-marker|token-marker|unexpected-marker/);
});

test('insecure or placeholder production URLs and embedded credentials are rejected', () => {
  for (const url of ['http://api.translacat.app', 'https://localhost/api/v1', 'https://10.0.2.2/api/v1', 'https://192.0.2.1/api/v1', 'https://api.example.com', 'https://api.example.com.', 'https://api.invalid', 'https://user:password@api.translacat.app', 'https://api.translacat.app?token=private', 'https://api.translacat.app#private']) {
    assert.throws(() => buildAppConfig({ ...productionEnvironment, EXPO_PUBLIC_API_URL: url }), /EXPO_PUBLIC_API_URL/);
  }
});

test('local development permits emulator HTTP but rejects remote HTTP', () => {
  const config = buildAppConfig({ EXPO_PUBLIC_API_URL: 'http://10.0.2.2:8080/api/v1/' });
  assert.equal(config.extra.apiBaseUrl, 'http://10.0.2.2:8080/api/v1');

  // 검증: 사설 IP와 비슷한 공개 도메인 이름은 HTTP 예외를 받을 수 없다.
  for (const url of ['http://api.translacat.app', 'http://10.evil.com', 'http://127.evil.com', 'http://192.168.evil.com', 'http://172.20.evil.com']) {
    assert.throws(() => buildAppConfig({ EXPO_PUBLIC_API_URL: url }), /HTTPS/);
  }
});

test('invalid environment, IDs, and project UUID fail before native generation', () => {
  assert.throws(() => buildAppConfig({ EXPO_PUBLIC_APP_ENV: 'prod' }), /EXPO_PUBLIC_APP_ENV/);
  assert.throws(() => buildAppConfig({ EXPO_PROJECT_ID: '00000000-0000-0000-0000-000000000000' }), /EXPO_PROJECT_ID/);
  assert.throws(() => buildAppConfig({ TRANSLACAT_ANDROID_PACKAGE: 'not-an-application-id' }), /TRANSLACAT_ANDROID_PACKAGE/);
  assert.throws(() => buildAppConfig({ TRANSLACAT_IOS_BUNDLE_IDENTIFIER: 'not an identifier' }), /TRANSLACAT_IOS_BUNDLE_IDENTIFIER/);
  assert.throws(() => buildAppConfig({ ...productionEnvironment, TRANSLACAT_ANDROID_PACKAGE: 'com.translacat.dev' }), /cannot contain/);
  assert.throws(() => buildAppConfig({ ...productionEnvironment, TRANSLACAT_IOS_BUNDLE_IDENTIFIER: 'com.translacat.preview' }), /cannot contain/);
});

test('cloud readiness checks verified metadata and Android Firebase file without calling EAS', () => {
  // 준비 / 실행: 프로젝트 링크와 Android 설정 파일 누락을 검사한다.
  const missingCloud = inspectBuildReadiness({}, { cloud: true, platform: 'android' });
  const missingFile = inspectBuildReadiness({ ...productionEnvironment, GOOGLE_SERVICES_JSON: './missing-google-services.json' }, { cloud: true, platform: 'android' });
  const ios = inspectBuildReadiness(productionEnvironment, { cloud: true, platform: 'ios' });

  // 검증: 로컬 검사만으로 원격 signing이나 푸시 성공을 주장하지 않는다.
  assert.ok(missingCloud.ready.some((message) => message.includes('EXPO_OWNER')));
  assert.ok(missingCloud.ready.some((message) => message.includes('EXPO_PROJECT_ID')));
  assert.deepEqual(missingCloud.errors, []);
  assert.ok(missingCloud.waiting.some((message) => message.includes('GOOGLE_SERVICES_JSON EAS File variable')));
  assert.ok(missingFile.errors.some((message) => message.includes('existing file')));
  assert.deepEqual(ios.errors, []);
  assert.ok(ios.waiting.some((message) => message.includes('APNs')));
});

test('remote Android builds require the injected Firebase file, not just an EAS variable name', () => {
  // 준비: 원격 Android 작업에서는 EAS가 File 변수를 실제 파일로 주입했어야 한다.
  const remote = { ...productionEnvironment, EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'android' };

  // 실행 / 검증: 미설정과 존재하지 않는 경로는 자격 내용 없이 명확히 실패한다.
  assert.throws(() => buildAppConfig(remote), /Android EAS build requires GOOGLE_SERVICES_JSON/);
  assert.throws(() => buildAppConfig({ ...remote, GOOGLE_SERVICES_JSON: './missing-google-services.json' }), /existing Firebase client configuration file/);
});

test('remote iOS builds do not require Android Firebase configuration', () => {
  // 준비 / 실행: iOS 원격 작업에는 Android 전용 File 변수를 요구하지 않는다.
  const config = buildAppConfig({ ...productionEnvironment, EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ios' });

  // 검증: iOS 식별자를 유지하며 Android 파일 경로를 만들어 넣지 않는다.
  assert.equal(config.ios?.bundleIdentifier, productionEnvironment.TRANSLACAT_IOS_BUNDLE_IDENTIFIER);
  assert.equal(config.android?.googleServicesFile, undefined);
});
