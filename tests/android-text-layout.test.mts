import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { ExportedConfig } from 'expo/config-plugins';
import type { ResourceGroupXML, ResourceXML } from '@expo/config-plugins/build/android/Resources';

const require = createRequire(import.meta.url);
const withAndroidTextLayout = require('../plugins/with-android-text-layout.cjs') as {
  (config: ExportedConfig): ExportedConfig;
  applyAndroidTextLayout(xml: ResourceXML): ResourceXML;
};
const { applyAndroidTextLayout } = withAndroidTextLayout;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(): ResourceXML {
  return {
    resources: {
      color: [{ $: { name: 'brand_primary' }, _: '#234567' }],
      style: [
        {
          $: { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' },
          item: [
            { $: { name: 'android:fontFamily' }, _: 'sans-serif' },
            { $: { name: 'android:textColor' }, _: '@color/brand_primary' },
            { $: { name: 'android:windowLightStatusBar' }, _: 'true' },
          ],
        },
        {
          $: { name: 'Theme.App.SplashScreen', parent: 'Theme.SplashScreen' },
          item: [
            { $: { name: 'windowSplashScreenBackground' }, _: '@color/brand_primary' },
            { $: { name: 'postSplashScreenTheme' }, _: '@style/AppTheme' },
          ],
        },
      ],
    },
  };
}

function style(xml: ResourceXML, name: string): ResourceGroupXML {
  const result = xml.resources.style?.find(candidate => candidate.$.name === name);
  assert.ok(result, `Missing fixture style: ${name}`);
  return result;
}

function effectiveItem(xml: ResourceXML, name: string, attribute: string): string | undefined {
  // 실행: 자식 스타일이 먼저 적용되는 Android 상속 순서로 유효한 값을 확인한다.
  const visited = new Set<string>();
  let currentName = name.replace(/^@style\//, '');
  while (!visited.has(currentName)) {
    visited.add(currentName);
    const current = xml.resources.style?.find(candidate => candidate.$.name === currentName);
    if (!current) return undefined;
    const ownValue = current.item.find(item => item.$.name === attribute);
    if (ownValue) return ownValue._;
    currentName = current.$.parent.replace(/^@style\//, '');
  }
  throw new Error('Fixture style inheritance has a cycle.');
}

test('Android text correction preserves the app theme, splash screen, typography and colors', () => {
  // 준비: 실제 Expo의 두 테마와 기존 글꼴·색상 설정을 함께 둔다.
  const xml = fixture();
  const previous = structuredClone(xml);

  // 실행: 앱 기본 텍스트 스타일만 전용 자식 스타일로 연결한다.
  assert.equal(applyAndroidTextLayout(xml), xml);

  // 검증: 원래 테마의 모든 설정과 스플래시·색상 리소스가 보존된다.
  const theme = style(xml, 'AppTheme');
  assert.deepEqual(theme.$, style(previous, 'AppTheme').$);
  assert.deepEqual(theme.item.filter(item => item.$.name !== 'android:textViewStyle'), style(previous, 'AppTheme').item);
  assert.deepEqual(style(xml, 'Theme.App.SplashScreen'), style(previous, 'Theme.App.SplashScreen'));
  assert.deepEqual(xml.resources.color, previous.resources.color);
  const reference = theme.item.find(item => item.$.name === 'android:textViewStyle')?._;
  assert.equal(reference, '@style/TranslaCatTextView');
  assert.equal(style(xml, 'TranslaCatTextView').$.parent, 'Widget.AppCompat.TextView');
  assert.equal(effectiveItem(xml, reference, 'android:useBoundsForWidth'), 'false');
  assert.equal(xml.resources.$?.['xmlns:tools'], 'http://schemas.android.com/tools');
});

test('custom text styles remain inherited while the child overrides bounds-based line breaking', () => {
  // 준비: 기존 사용자 글꼴 스타일이 bounds 기반 줄바꿈을 켠 경우를 재현한다.
  const xml = fixture();
  style(xml, 'AppTheme').item.push({ $: { name: 'android:textViewStyle' }, _: '@style/ExistingTextView' });
  xml.resources.style!.push({
    $: { name: 'ExistingTextView', parent: 'Widget.AppCompat.TextView' },
    item: [
      { $: { name: 'android:useBoundsForWidth' }, _: 'true' },
      { $: { name: 'android:fontFamily' }, _: 'custom_font' },
      { $: { name: 'android:textColor' }, _: '#123456' },
    ],
  });
  const originalTextStyle = structuredClone(style(xml, 'ExistingTextView'));

  // 실행: 기존 스타일을 수정하지 않고 전용 자식 스타일에서 줄바꿈만 재정의한다.
  applyAndroidTextLayout(xml);

  // 검증: 부모의 true보다 자식의 false가 우선하며 글꼴·색상 상속은 유지된다.
  assert.deepEqual(style(xml, 'ExistingTextView'), originalTextStyle);
  assert.equal(style(xml, 'TranslaCatTextView').$.parent, '@style/ExistingTextView');
  assert.equal(effectiveItem(xml, 'ExistingTextView', 'android:useBoundsForWidth'), 'true');
  assert.equal(effectiveItem(xml, 'TranslaCatTextView', 'android:useBoundsForWidth'), 'false');
  assert.equal(effectiveItem(xml, 'TranslaCatTextView', 'android:fontFamily'), 'custom_font');
  assert.equal(effectiveItem(xml, 'TranslaCatTextView', 'android:textColor'), '#123456');
});

test('repeated native generation does not duplicate resources or create a self-parent', () => {
  // 준비 / 실행: prebuild가 같은 XML에 다시 적용되는 상황을 확인한다.
  const xml = applyAndroidTextLayout(fixture());
  const once = structuredClone(xml);
  applyAndroidTextLayout(xml);
  applyAndroidTextLayout(xml);

  // 검증: 전체 XML 결과가 같으므로 테마 참조와 상속 관계도 누적되지 않는다.
  assert.deepEqual(xml, once);
  assert.notEqual(style(xml, 'TranslaCatTextView').$.parent, '@style/TranslaCatTextView');
});

test('missing AppTheme fails before creating or modifying resources', () => {
  // 준비: 다른 테마만 있는 문서를 전달해 잘못된 테마 생성을 방지한다.
  const xml = fixture();
  xml.resources.style = xml.resources.style!.filter(candidate => candidate.$.name !== 'AppTheme');
  const previous = structuredClone(xml);

  // 실행 / 검증: 명시적으로 실패하고 원래 문서를 그대로 유지한다.
  assert.throws(() => applyAndroidTextLayout(xml), /AppTheme/);
  assert.deepEqual(xml, previous);
});

test('ambiguous theme and text-style definitions fail without changing the document', () => {
  const documents = [fixture(), fixture(), fixture()];
  documents[0].resources.style!.push(structuredClone(style(documents[0], 'AppTheme')));
  style(documents[1], 'AppTheme').item.push(
    { $: { name: 'android:textViewStyle' }, _: '@style/First' },
    { $: { name: 'android:textViewStyle' }, _: '@style/Second' },
  );
  for (let index = 0; index < 2; index += 1) {
    documents[2].resources.style!.push({ $: { name: 'TranslaCatTextView', parent: 'Widget.AppCompat.TextView' }, item: [] });
  }

  for (const xml of documents) {
    // 실행 / 검증: 임의의 첫 번째 항목을 수정하는 대신 중복을 명확히 거부한다.
    const previous = structuredClone(xml);
    assert.throws(() => applyAndroidTextLayout(xml), /ambiguous|AppTheme/i);
    assert.deepEqual(xml, previous);
  }
});

test('dynamic, malformed and self-parent references are rejected while external styles remain valid', () => {
  for (const reference of ['?attr/textViewStyle', '@color/not_a_style', '@style/', 'invalid style']) {
    // 준비 / 실행 / 검증: 정적으로 상속할 수 없는 참조를 기존 문서 변경 전에 거부한다.
    const xml = fixture();
    style(xml, 'AppTheme').item.push({ $: { name: 'android:textViewStyle' }, _: reference });
    const previous = structuredClone(xml);
    assert.throws(() => applyAndroidTextLayout(xml), /literal parent text style/);
    assert.deepEqual(xml, previous);
  }

  // 준비 / 실행 / 검증: 재실행 시 전용 스타일이 자기 자신을 상속할 수 없다.
  const cyclic = applyAndroidTextLayout(fixture());
  style(cyclic, 'TranslaCatTextView').$.parent = '@style/TranslaCatTextView';
  assert.throws(() => applyAndroidTextLayout(cyclic), /literal parent text style/);

  // 검증: 같은 XML에 선언되지 않은 라이브러리 스타일 참조도 정상적으로 상속한다.
  const external = fixture();
  style(external, 'AppTheme').item.push({ $: { name: 'android:textViewStyle' }, _: '@style/Library.TextView' });
  applyAndroidTextLayout(external);
  assert.equal(style(external, 'TranslaCatTextView').$.parent, '@style/Library.TextView');
});

test('the registered Expo Android styles mod executes and preserves the existing mod chain', async () => {
  // 준비: Expo의 실제 mod 체인과 XML 결과를 사용하고 파일 생성은 하지 않는다.
  let previousModCalls = 0;
  const config = withAndroidTextLayout({
    name: 'TranslaCat test',
    slug: 'translacat-test',
    mods: { android: { styles: result => { previousModCalls += 1; return result; } } },
  });
  const stylesMod = config.mods?.android?.styles;
  assert.equal(typeof stylesMod, 'function');
  assert.ok(stylesMod);
  const xml = fixture();

  // 실행: withAndroidStyles가 등록한 실제 래퍼를 호출한다.
  const result = await stylesMod({
    ...config,
    modResults: xml,
    modRawConfig: { name: config.name, slug: config.slug },
    modRequest: { projectRoot, platformProjectRoot: resolve(projectRoot, 'android'), modName: 'styles', platform: 'android', introspect: true },
  });

  // 검증: 기존 mod가 이어서 호출되고 native XML의 유효한 텍스트 스타일이 연결된다.
  assert.equal(previousModCalls, 1);
  assert.equal(result.modResults, xml);
  const reference = style(result.modResults, 'AppTheme').item.find(item => item.$.name === 'android:textViewStyle')?._;
  assert.equal(reference, '@style/TranslaCatTextView');
  assert.equal(effectiveItem(result.modResults, reference, 'android:useBoundsForWidth'), 'false');
});
