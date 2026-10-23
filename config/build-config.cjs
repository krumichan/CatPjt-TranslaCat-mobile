const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const projectLink = require('./project-link.json');

const APP_ENVIRONMENTS = ['development', 'preview', 'production'];
const BUILD_PROFILE_ENVIRONMENTS = { development: 'development', device: 'development', preview: 'preview', production: 'production' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const ANDROID_PACKAGE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}$/;
const IOS_IDENTIFIER = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){2,}$/i;

function value(env, name) {
  return typeof env[name] === 'string' ? env[name].trim() : '';
}

function isExistingFile(filename, projectRoot = process.cwd()) {
  if (!filename) return false;
  try {
    return fs.statSync(path.resolve(projectRoot, filename)).isFile();
  } catch {
    return false;
  }
}

function isLocalHostname(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host.endsWith('.local')) return true;

  // 숫자처럼 시작하는 공개 도메인을 사설 IPv4 주소로 취급하지 않는다.
  if (isIP(host) !== 4) return false;
  return host === '0.0.0.0' || host.startsWith('127.') || host.startsWith('10.')
    || host.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

function appEnvironmentForBuildProfile(profile, platform) {
  if (!Object.hasOwn(BUILD_PROFILE_ENVIRONMENTS, profile)) {
    throw new Error('Build profile must be development, device, preview, or production.');
  }
  if (platform && !['android', 'ios', 'all'].includes(platform)) throw new Error('Platform must be android, ios, or all.');
  if (profile === 'device' && platform && platform !== 'android') throw new Error('The device build profile supports Android only.');
  return BUILD_PROFILE_ENVIRONMENTS[profile];
}

function isPublicApiHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (isLocalHostname(host) || /(^|\.)(example\.(com|org|net)|invalid|example|test|local|localhost)$/.test(host)) return false;

  // 실기기 APK에 사설망·문서용 IP를 포함하지 않는다. 공인 IP의 실제 TLS 연결은 별도로 검증한다.
  const family = isIP(host);
  if (family === 4) {
    const [first, second, third] = host.split('.').map(Number);
    return !(first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 168 || (second === 0 && (third === 0 || third === 2))))
      || (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
      || (first === 203 && second === 0 && third === 113));
  }
  if (family === 6) return /^[23]/.test(host) && !/^2001:db8(?::|$)/.test(host);
  return host.includes('.');
}

function validateDeviceApi(apiBaseUrl, raw, errors) {
  if (!raw) {
    errors.push('The device build profile requires EXPO_PUBLIC_API_URL for a public HTTPS API ending in /api/v1.');
    return;
  }
  if (!apiBaseUrl) return;

  // Metro를 쓰지 않는 기기 검증은 로컬 HTTP 예외와 미완성 API 경로를 허용하지 않는다.
  const url = new URL(apiBaseUrl);
  if (url.protocol !== 'https:' || !isPublicApiHostname(url.hostname) || !url.pathname.endsWith('/api/v1')) {
    errors.push('The device build profile requires a public HTTPS EXPO_PUBLIC_API_URL ending in /api/v1.');
  }
}

function readApiBaseUrl(raw, appEnvironment, errors) {
  if (!raw) return null;

  // API 주소에 인증 값이나 요청별 query가 섞이지 않도록 공개 base URL만 허용한다.
  let url;
  try {
    url = new URL(raw);
  } catch {
    errors.push('EXPO_PUBLIC_API_URL must be an absolute HTTP(S) URL.');
    return null;
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    errors.push('EXPO_PUBLIC_API_URL must use HTTP(S) without credentials, query, or fragment.');
    return null;
  }
  if (url.protocol !== 'https:' && !(appEnvironment === 'development' && isLocalHostname(url.hostname))) {
    errors.push('EXPO_PUBLIC_API_URL requires HTTPS; development may use a local HTTP server.');
    return null;
  }

  // production은 예제 주소나 개발 장비를 실제 서비스 연결로 오인하지 않는다.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const exampleHost = /(^|\.)(example\.(com|org|net)|invalid|example|test)$/.test(host);
  if (appEnvironment === 'production' && (isLocalHostname(host) || isIP(host) || exampleHost || !host.includes('.'))) {
    errors.push('Production EXPO_PUBLIC_API_URL must use a real public server hostname.');
    return null;
  }
  return url.toString().replace(/\/$/, '');
}

function readConfiguration(env) {
  const errors = [];
  const appEnvironment = value(env, 'EXPO_PUBLIC_APP_ENV') || 'development';
  if (!APP_ENVIRONMENTS.includes(appEnvironment)) {
    errors.push('EXPO_PUBLIC_APP_ENV must be development, preview, or production.');
  }

  // 계정과 프로젝트는 실제로 등록한 값만 연결한다. 누락 값을 가짜 ID로 채우지 않는다.
  const owner = value(env, 'EXPO_OWNER') || projectLink.owner;
  const projectId = value(env, 'EXPO_PROJECT_ID') || projectLink.projectId;
  if (owner && !OWNER.test(owner)) errors.push('EXPO_OWNER must be a valid Expo account or organization name.');
  if (projectId && !UUID.test(projectId)) errors.push('EXPO_PROJECT_ID must be a valid project UUID.');

  const production = appEnvironment === 'production';
  const suffix = appEnvironment === 'preview' ? 'preview' : 'dev';
  const androidPackage = value(env, 'TRANSLACAT_ANDROID_PACKAGE') || (production ? '' : `com.krumichan.translacat.${suffix}`);
  const iosBundleIdentifier = value(env, 'TRANSLACAT_IOS_BUNDLE_IDENTIFIER') || (production ? '' : `com.krumichan.translacat.${suffix}`);
  if (!ANDROID_PACKAGE.test(androidPackage)) errors.push('TRANSLACAT_ANDROID_PACKAGE must be an explicit valid Android application ID for production.');
  if (!IOS_IDENTIFIER.test(iosBundleIdentifier)) errors.push('TRANSLACAT_IOS_BUNDLE_IDENTIFIER must be an explicit valid iOS bundle identifier for production.');
  if (production && [androidPackage, iosBundleIdentifier].some((identifier) => /(^|\.)(dev|development|preview)(\.|$)/i.test(identifier))) {
    errors.push('Production application identifiers cannot contain a development or preview segment.');
  }

  const apiBaseUrl = readApiBaseUrl(value(env, 'EXPO_PUBLIC_API_URL'), appEnvironment, errors);
  if (value(env, 'EAS_BUILD_PROFILE') === 'device') {
    if (appEnvironment !== 'development') errors.push('The device build profile requires EXPO_PUBLIC_APP_ENV=development.');
    if (value(env, 'EAS_BUILD_PLATFORM') && value(env, 'EAS_BUILD_PLATFORM') !== 'android') errors.push('The device build profile supports Android only.');
    validateDeviceApi(apiBaseUrl, value(env, 'EXPO_PUBLIC_API_URL'), errors);
  }
  const googleServicesFile = value(env, 'GOOGLE_SERVICES_JSON');
  if (production) {
    if (!owner) errors.push('Production requires EXPO_OWNER.');
    if (!projectId) errors.push('Production requires EXPO_PROJECT_ID.');
    if (!value(env, 'EXPO_PUBLIC_API_URL')) errors.push('Production requires EXPO_PUBLIC_API_URL.');
  }

  return { appEnvironment, owner, projectId, androidPackage, iosBundleIdentifier, apiBaseUrl, googleServicesFile, errors };
}

function buildAppConfig(env = process.env) {
  const settings = readConfiguration(env);

  // EAS File 변수는 원격 Android 작업에서 실제 파일 경로가 된 뒤 검증한다.
  // 로컬에 변수가 없다는 이유로 대시보드의 원격 파일 구성을 부정하지 않는다.
  if (value(env, 'EAS_BUILD') === 'true' && value(env, 'EAS_BUILD_PLATFORM') === 'android'
      && !isExistingFile(settings.googleServicesFile)) {
    settings.errors.push('Android EAS build requires GOOGLE_SERVICES_JSON to point to an existing Firebase client configuration file. Configure an EAS File environment variable.');
  }
  if (settings.errors.length) throw new Error(`Invalid TranslaCat app configuration:\n- ${settings.errors.join('\n- ')}`);

  const suffix = settings.appEnvironment === 'production' ? '' : ` (${settings.appEnvironment === 'development' ? 'Dev' : 'Preview'})`;
  const scheme = settings.appEnvironment === 'production' ? 'translacat' : `translacat-${settings.appEnvironment === 'development' ? 'dev' : 'preview'}`;

  // 클라이언트에 공개되는 extra는 허용한 연결 정보만 직접 작성한다.
  return {
    name: `TranslaCat${suffix}`,
    slug: projectLink.slug,
    version: '0.1.0',
    icon: './assets/brand/app-icon.png',
    orientation: 'portrait',
    scheme,
    userInterfaceStyle: 'automatic',
    ...(settings.owner ? { owner: settings.owner } : {}),
    ios: { supportsTablet: false, bundleIdentifier: settings.iosBundleIdentifier },
    android: {
      softwareKeyboardLayoutMode: 'resize',
      adaptiveIcon: { foregroundImage: './assets/brand/app-icon.png', backgroundColor: '#F3F7FB' },
      package: settings.androidPackage,
      ...(settings.googleServicesFile ? { googleServicesFile: settings.googleServicesFile } : {}),
    },
    web: { bundler: 'metro', output: 'static' },
    plugins: ['expo-router', ['expo-notifications', { defaultChannel: 'chat-messages' }], 'expo-secure-store', 'expo-dev-client', 'expo-web-browser', './plugins/with-android-text-layout.cjs'],
    experiments: { typedRoutes: true },
    extra: {
      appEnvironment: settings.appEnvironment,
      ...(settings.apiBaseUrl ? { apiBaseUrl: settings.apiBaseUrl } : {}),
      ...(settings.projectId ? { eas: { projectId: settings.projectId } } : {}),
    },
  };
}

function inspectBuildReadiness(env = process.env, options = {}) {
  // 빌드 profile은 앱 환경과 분리한다. device도 기존 development 식별자와 EAS 자격을 사용한다.
  let configurationEnv = env;
  const profileErrors = [];
  if (options.profile) {
    try {
      configurationEnv = { ...env, EXPO_PUBLIC_APP_ENV: appEnvironmentForBuildProfile(options.profile, options.platform || 'all'), EAS_BUILD_PROFILE: options.profile };
    } catch (error) {
      profileErrors.push(error.message);
    }
  }
  const settings = readConfiguration(configurationEnv);
  const ready = [];
  const waiting = [];
  const errors = [...profileErrors, ...settings.errors];
  const platform = options.platform || 'all';
  if (!['android', 'ios', 'all'].includes(platform)) errors.push('Platform must be android, ios, or all.');

  // 로컬 실행에 없는 외부 연결을 구분하되 실제 클라우드 준비 검사에서는 필수값으로 판단한다.
  if (APP_ENVIRONMENTS.includes(settings.appEnvironment)) ready.push(`App environment: ${settings.appEnvironment}`);
  if (settings.errors.length === 0) ready.push('Native identifiers and URL scheme are separated by environment.');
  if (settings.apiBaseUrl) ready.push('Public API URL is configured.');
  else waiting.push('Public API connection is not configured; server features remain unavailable.');
  for (const [configured, name] of [[settings.owner, 'EXPO_OWNER'], [settings.projectId, 'EXPO_PROJECT_ID']]) {
    if (configured) ready.push(`${name} is supplied; remote ownership has not been verified.`);
    else if (options.cloud) errors.push(`Cloud build readiness requires ${name}.`);
    else waiting.push(`${name} is not configured; local development remains available.`);
  }

  // Firebase 파일은 내용과 자격을 출력하지 않고 존재 여부만 확인한다.
  if (options.cloud && ['android', 'all'].includes(platform)) {
    if (!settings.googleServicesFile) waiting.push('GOOGLE_SERVICES_JSON EAS File variable and Android FCM credentials have not been verified locally. The remote Android build validates the injected file.');
    else if (isExistingFile(settings.googleServicesFile, options.projectRoot)) ready.push('Android Firebase client configuration file exists; cloud credentials remain unverified.');
    else errors.push('GOOGLE_SERVICES_JSON must point to an existing file when supplied locally.');
  }
  if (options.cloud && ['ios', 'all'].includes(platform)) waiting.push('Apple signing, APNs credentials, and device registration require a separate EAS account check.');
  waiting.push('Real Android/iPhone builds and push delivery have not been verified by this local check.');
  return { appEnvironment: settings.appEnvironment, ready, waiting, errors };
}

module.exports = { appEnvironmentForBuildProfile, buildAppConfig, inspectBuildReadiness };
