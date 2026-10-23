const { AndroidConfig, withAndroidStyles } = require('expo/config-plugins');

// Android 측정/그리기 불일치: https://github.com/react/react-native/commit/dcdb52b
// 같은 수정이 포함된 RN으로 올릴 때 이 앱 전용 테마 설정의 제거를 검토한다.
const TEXT_STYLE = 'TranslaCatTextView';
const TEXT_STYLE_REF = `@style/${TEXT_STYLE}`;
const TEXT_STYLE_ATTRIBUTE = 'android:textViewStyle';

function applyAndroidTextLayout(xml) {
  if (xml.resources.style?.filter(style => style.$.name === 'AppTheme').length !== 1) {
    throw new Error('Android text layout requires one generated AppTheme.');
  }
  const theme = AndroidConfig.Styles.getStyleParent(xml, AndroidConfig.Styles.getAppThemeGroup());

  // OEM 기본값보다 우선하도록 전용 TextView 스타일을 연결하고 기존 글꼴 스타일은 상속한다.
  const references = (theme.item ?? []).filter(item => item.$.name === TEXT_STYLE_ATTRIBUTE);
  const ownedStyles = (xml.resources.style ?? []).filter(style => style.$.name === TEXT_STYLE);
  if (references.length > 1 || ownedStyles.length > 1) throw new Error('Android text layout found ambiguous text styles.');
  const reference = references[0]?._;
  const existing = ownedStyles[0];
  const parent = reference && reference !== TEXT_STYLE_REF
    ? reference
    : existing?.$.parent ?? 'Widget.AppCompat.TextView';
  if (!/^(?:@(?:android:)?style\/)?[\w.]+$/.test(parent) || parent === TEXT_STYLE || parent === TEXT_STYLE_REF) {
    throw new Error('Android text layout requires a literal parent text style.');
  }
  if (existing) existing.$.parent = parent;

  xml.resources.$ ??= {};
  xml.resources.$['xmlns:tools'] ??= 'http://schemas.android.com/tools';

  // Android 15+의 bounds 기반 줄바꿈을 끄면 RN의 글자 폭 측정과 실제 그리기가 일치한다.
  // RN dcdb52b / #58280과 같은 opt-out이며, 하위 Android는 이 속성을 읽지 않는다.
  AndroidConfig.Styles.assignStylesValue(xml, {
    add: true,
    name: 'android:useBoundsForWidth',
    value: 'false',
    targetApi: '35',
    parent: { name: TEXT_STYLE, parent },
  });
  AndroidConfig.Styles.assignStylesValue(xml, {
    add: true,
    name: TEXT_STYLE_ATTRIBUTE,
    value: TEXT_STYLE_REF,
    parent: AndroidConfig.Styles.getAppThemeGroup(),
  });
  return xml;
}

module.exports = function withAndroidTextLayout(config) {
  return withAndroidStyles(config, mod => {
    mod.modResults = applyAndroidTextLayout(mod.modResults);
    return mod;
  });
};
module.exports.applyAndroidTextLayout = applyAndroidTextLayout;
