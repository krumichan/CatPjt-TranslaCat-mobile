# TranslaCat Mobile

React Native, Expo, TypeScript로 만드는 TranslaCat 모바일 앱이다. 기존 TranslaCat 웹과 같은 BE·CHAT 계약을 사용하고, 공개 HTTPS API와 WSS로 연결한다. Android 기기를 중심으로 개발하며 iOS 네이티브 빌드·서명·APNs와 실기기 검증은 별도로 진행한다.

React Native、Expo、TypeScript で開発する TranslaCat モバイルアプリです。既存の TranslaCat Web と同じ BE・CHAT 契約を使用し、公開 HTTPS API と WSS に接続します。Android 端末を中心に開発しており、iOS のネイティブビルド・署名・APNs・実機検証は別途進めます。

## 제공 기능 / 提供機能

- Google 웹 로그인 후 앱 자동 복귀, 이메일 로그인, 기기별 세션 복원·갱신·로그아웃
  - Google Web ログイン後のアプリへの自動復帰、メールログイン、端末別セッションの復元・更新・ログアウト
- DIRECT·GROUP·OPEN 채팅, 번역, 읽음과 안 읽음 수, 실시간 메시지
  - DIRECT・GROUP・OPEN チャット、翻訳、既読と未読数、リアルタイムメッセージ
- AI 대화와 AI 참여자 설정
  - AI との会話と AI 参加者の設定
- 친구와 공개 오픈채팅 탐색, TranslaCat ID 확인·공유, ID 초대와 초대 링크
  - フレンドと公開オープンチャットの検索、TranslaCat ID の確認・共有、ID 招待と招待リンク
- 방 정보·참여자 관리, 권한에 따른 관리자 지정·방장 위임·강퇴
  - ルーム情報・参加者の管理、権限に応じた管理者指定・オーナー権限の譲渡・強制退出
- 기기 푸시 등록, 알림에서 해당 방 이동, 전체 알림·방별 무음·배지 설정
  - 端末のプッシュ登録、通知から該当ルームへの移動、全体通知・ルーム別ミュート・バッジ設定
- 사용자 차단·해제, 메시지 신고, 고객센터 문의와 운영 답변 확인
  - ユーザーのブロック・解除、メッセージの通報、サポートへの問い合わせと運営からの回答確認
- 계정 탈퇴 요청·처리 상태 안내
  - アカウント退会申請と処理状況の案内

탈퇴 접수와 실제 삭제 처리는 운영 BE·CHAT·LL의 기능·설정에 따른다. 모바일 화면이나 테스트가 준비됐다는 사실만으로 운영 활성화와 실제 계정 삭제 완료를 뜻하지 않는다. Apple 로그인과 iPhone 검증도 별도 준비 항목이다.

退会の受付と実際の削除処理は、本番 BE・CHAT・LL の機能・設定に従います。モバイル画面やテストの準備完了だけで、本番での有効化や実際のアカウント削除完了を意味するものではありません。Apple ログインと iPhone の検証も別途準備が必要です。

## 소스 구조 / ソース構成

화면 진입점과 기능 구현, 공통 통신·UI를 분리한다. 라우트에서 기능 화면을 연결하고, 기능별 계약·상태 처리와 API 호출 경계를 유지한다.

画面の入口、機能実装、共通通信・UI を分離します。ルートから各機能画面を接続し、機能別の契約・状態処理と API 呼び出しの境界を維持します。

| 경로 / パス | 역할 / 役割 |
| --- | --- |
| `src/app/` | Expo Router의 탭·인증·대화방·설정 경로와 화면 연결<br>Expo Router のタブ・認証・ルーム・設定の経路と画面の接続 |
| `src/features/` | 채팅, AI, 친구·초대, 방 관리, 문의·신고·탈퇴 등의 기능별 구현<br>チャット、AI、フレンド・招待、ルーム管理、問い合わせ・通報・退会などの機能別実装 |
| `src/api/` | 기존 BE 응답 envelope와 인증 토큰 전달을 다루는 API 경계<br>既存 BE の応答 envelope と認証トークンの受け渡しを扱う API 境界 |
| `src/auth/`, `src/providers/` | 세션 수명주기와 앱 공통 provider<br>セッションのライフサイクルとアプリ共通 provider |
| `src/domain/` | 식별자·메시지 등 공통 규칙<br>識別子・メッセージなどの共通ルール |
| `src/realtime/`, `src/notifications/` | 실시간 연결과 기기 알림 수명주기<br>リアルタイム接続と端末通知のライフサイクル |
| `src/ui/` | 웹의 색상·브랜드 느낌을 공유하는 모바일 공통 UI와 테마<br>Web の色・ブランドイメージを共有するモバイル共通 UI とテーマ |
| `src/config/`, `config/`, `plugins/` | 공개 실행 설정, Expo 프로젝트 연결, 네이티브 설정 플러그인<br>公開実行設定、Expo プロジェクトの接続、ネイティブ設定プラグイン |
| `scripts/`, `tests/` | 설정·빌드 도구와 기능 계약·상태 처리의 집중 테스트<br>設定・ビルドツールと機能契約・状態処理の重点テスト |

새 기능은 가장 가까운 기능 폴더에 두고, 여러 기능이 실제로 공유하는 규칙만 공통 계층에 둔다. 서버 API와 알림 payload에 비밀값을 포함하지 않는다.

新機能は最も近い機能フォルダーに配置し、複数の機能で実際に共有するルールだけを共通層に置きます。サーバー API や通知 payload に秘密情報を含めません。

웹 FE의 채팅·언어학습 구조처럼 같은 기능 안에서 화면, 상태, 표시 역할을 찾아갈 수 있도록 정리한다.

Web FE のチャット・言語学習の構成と同様に、同じ機能の中で画面・状態・表示の役割をたどれるよう整理しています。

- 채팅: `ChatRoomScreen`이 화면을 연결하고, 메시지 표시·입력은 `ChatMessageItem`·`ChatMessageInput`으로 나눈다. `useRoomChat`·`useChatScroll`이 기존 대화·스크롤 처리를 맡는다.
  - チャット：`ChatRoomScreen` が画面を接続し、メッセージ表示・入力は `ChatMessageItem`・`ChatMessageInput` に分けます。`useRoomChat`・`useChatScroll` が既存の会話・スクロール処理を担当します。
- 문의함: `SupportScreen` → `useSupportWorkspace` → `SupportWorkspaceView` → `SupportInquirySections`로 화면 진입, 상태 조합, 전체 표시, 문의별 표시를 나눈다.
  - 問い合わせ：`SupportScreen` → `useSupportWorkspace` → `SupportWorkspaceView` → `SupportInquirySections` により、画面の入口・状態の組み合わせ・全体表示・問い合わせ別表示を分けます。
- 친구: `FriendsScreen`에서 요청·계정 상태를 관리하고, `FriendRequestSection`·`FriendListItem`이 요청 목록과 친구 항목을 표시한다.
  - フレンド：`FriendsScreen` が申請・アカウント状態を管理し、`FriendRequestSection`・`FriendListItem` が申請一覧とフレンド項目を表示します。

화면을 나누는 과정에서도 기존 `service.ts`의 API 계약과 `controller.ts`·계정별 요청 수명주기 경계는 유지한다. 표시 컴포넌트에 별도 통신·저장 규칙을 복제하지 않는다.

画面を分割しても、既存の `service.ts` の API 契約と `controller.ts`・アカウント別リクエストのライフサイクル境界を維持します。表示コンポーネントに別の通信・保存ルールを複製しません。

## 환경 설정 / 環境設定

프로젝트에 맞는 Node와 `npm.cmd`를 사용하고 의존성은 `package-lock.json`을 기준으로 준비한다. 전역 PATH·NVM 변경이나 의존성 업그레이드는 일반 실행 절차에 포함하지 않는다.

プロジェクトに適した Node と `npm.cmd` を使用し、依存関係は `package-lock.json` を基準に準備します。グローバル PATH・NVM の変更や依存関係のアップグレードは通常の実行手順に含めません。

`.env.example`을 바탕으로 로컬 환경을 준비한다. 공개 BE 주소는 `/api/v1`까지 포함한 HTTPS 주소여야 한다. `EXPO_PUBLIC_*` 값은 앱에 포함되므로 내부 서비스 키·OAuth client secret·서버 푸시 자격·실제 사용자 토큰을 넣지 않는다. 공개 owner·projectId는 `config/project-link.json`에서 관리한다.

`.env.example` を基にローカル環境を準備します。公開 BE アドレスは `/api/v1` まで含む HTTPS アドレスである必要があります。`EXPO_PUBLIC_*` の値はアプリに含まれるため、内部サービスキー・OAuth client secret・サーバーのプッシュ認証情報・実際のユーザートークンを設定しません。公開 owner・projectId は `config/project-link.json` で管理します。

## 실행과 검증 / 実行と検証

공용 작업 환경에서는 [데스크톱 공용 운영 문서 / デスクトップ共通運用文書](https://github.com/krumichan/CatPjt-TranslaCat-docs/blob/main/repositories/shared/docs/desktop-workloads.md)와 현재 workspace의 `.codex-workspace/verification/shared/desktop-workloads-20261023/projects.json`을 먼저 확인한다. 준비한 소스 사본과 작업별 어댑터를 공용 실행기로 보내며, 운영 `.env`·서명키·실사용자 데이터를 자동 복사하지 않는다. 슬롯이 사용 중이면 기존 작업을 종료하거나 중복 제출하지 않고 다음 실행 시점을 조정한다. 연결이 끊기면 같은 JobId의 결과부터 회수한다.

共通作業環境では、上記のデスクトップ共通運用文書と現在の workspace にある `.codex-workspace/verification/shared/desktop-workloads-20261023/projects.json` を先に確認します。準備したソースのコピーと作業別アダプターを共通実行ツールへ送り、本番 `.env`・署名鍵・実ユーザーデータを自動コピーしません。スロットの使用中は既存作業を終了したり重複送信したりせず、次の実行時点を調整します。接続が切れた場合は同じ JobId の結果から回収します。

아래는 준비된 실행 환경에서 사용하는 프로젝트 명령이다. 데스크톱 연결 실패만으로 노트북에서 자동 실행하지 않는다. 로컬 실행은 사용자가 지정했거나 데스크톱 사용이 불가능한 상황에 진행한다.

以下は、準備済みの実行環境で使うプロジェクトコマンドです。デスクトップへの接続失敗だけを理由にノート PC で自動実行しません。ローカル実行はユーザーが指定した場合、またはデスクトップを使用できない状況で行います。

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run config:check
```

집중 테스트는 공개 설정 차단, 인증·기기·알림 경계와 기능별 계약·상태 처리를 확인한다. 설정 검사의 `WAIT`는 외부 자격이 미검증이라는 뜻이다. 검사 성공, 웹 bundle, APK 생성, 실기기 기능 확인은 서로 구분한다.

重点テストでは、公開設定への秘密情報混入の防止、認証・端末・通知の境界、機能別の契約・状態処理を確認します。設定検査の `WAIT` は外部認証情報が未検証であることを示します。検査成功、Web bundle、APK 生成、実機での機能確認は区別します。

개발용 native 앱과 Metro를 연결할 때는 `npm.cmd run start`를 사용한다. `npm.cmd run web`은 모바일 화면의 웹 미리보기이며 기존 TranslaCat 웹 배포와 별개다. 설정의 개발 점검 화면은 개발 모드에서만 사용하고, 화면 메모리에 표시한 진단 토큰을 로그나 Git에 남기지 않는다.

開発用 native アプリと Metro の接続には `npm.cmd run start` を使います。`npm.cmd run web` はモバイル画面の Web プレビューで、既存 TranslaCat Web のデプロイとは別です。設定内の開発点検画面は開発モードでのみ使用し、画面メモリーに表示した診断トークンをログや Git に残しません。

## Android와 iOS 빌드 / Android と iOS のビルド

EAS 계정 확인과 빌드는 프로젝트에 고정한 CLI를 사용한다. 로그인은 계정 소유자가 수행한다.

EAS アカウントの確認とビルドには、プロジェクトで固定した CLI を使用します。ログインはアカウント所有者が行います。

```powershell
npm.cmd exec -- eas login
npm.cmd exec -- eas whoami
npm.cmd exec -- eas project:info
npm.cmd run config:check -- --cloud --profile device --platform android
```

| 프로필 / プロファイル | 용도 / 用途 | Android 결과 / Android 成果物 |
| --- | --- | --- |
| `development` | 개발용 native 앱에서 Metro 연결 / 開発用 native アプリで Metro に接続 | APK |
| `device` | JavaScript bundle을 포함한 기기 확인 / JavaScript bundle を含む実機確認 | APK |
| `preview` | 내부 배포용 미리보기 / 内部配布用プレビュー | APK |
| `production` | 출시용 빌드 / リリース用ビルド | AAB |

```powershell
npm.cmd run build:development:android
npm.cmd run build:device:android
npm.cmd run build:preview:android
npm.cmd run build:production:android
```

이 빌드 명령들은 사전 검사 후 실제 EAS 클라우드 빌드를 요청한다. 클라우드 사용량과 요금제 조건은 실행 전에 확인한다. `device`는 Metro나 같은 Wi-Fi 없이 실행할 수 있고, 현재 개발 앱 식별자 `com.krumichan.translacat.dev`와 `translacat-dev` scheme을 사용한다. 업데이트 설치 가능 여부는 실제 서명 일치와 기기 설치에서 확인한다.

これらのビルドコマンドは事前検査後に実際の EAS クラウドビルドをリクエストします。実行前にクラウド使用量と料金プランの条件を確認します。`device` は Metro や同じ Wi-Fi なしで実行でき、現在の開発用アプリ識別子 `com.krumichan.translacat.dev` と `translacat-dev` scheme を使用します。更新インストールの可否は、実際の署名一致と端末へのインストールで確認します。

Firebase 클라이언트 파일은 승인된 EAS 환경의 `GOOGLE_SERVICES_JSON` File 변수로 주입하며, 별도 FCM 서버 자격은 Expo 자격 관리에 연결한다. 원격 빌드에 필요한 파일이 없으면 중단한다. 로컬 파일을 Git이나 EAS 소스 archive에 넣어 우회하지 않는다. API 주소는 bundle에 포함되므로 변경 후 다시 빌드한다. 설정 검사만으로 DNS·인증서·서버 응답·푸시 수신을 확인한 것은 아니다.

Firebase クライアントファイルは、承認済み EAS 環境の `GOOGLE_SERVICES_JSON` File 変数から注入し、別の FCM サーバー認証情報は Expo の認証情報管理に接続します。リモートビルドに必要なファイルがなければ中断します。ローカルファイルを Git や EAS のソース archive に入れて回避しません。API アドレスは bundle に含まれるため、変更後は再ビルドします。設定検査だけで DNS・証明書・サーバー応答・プッシュ受信を確認したことにはなりません。

iOS 빌드는 Mac 또는 준비된 클라우드 빌드 경로를 사용한다. Apple 개발자 등록·서명·APNs·실기기 준비를 완료한 뒤 `build:development:ios`, `build:preview:ios`, `build:production:ios` 명령을 사용한다.

iOS ビルドは Mac または準備済みのクラウドビルド経路を使用します。Apple 開発者登録・署名・APNs・実機の準備完了後に、`build:development:ios`、`build:preview:ios`、`build:production:ios` コマンドを使用します。

## 기존 Windows 로컬 APK 도구 / 既存 Windows ローカル APK ツール

`scripts/build-local-android.mjs`는 기존 Windows SDK·개발용 서명 환경에 맞춰 만든 도구다. 새 PC에서 바로 실행하는 범용 설치 도구나 데스크톱 원격 어댑터가 아니다. 공용 데스크톱에는 이 스크립트를 그대로 전송해 실행하지 않고, SDK·JDK·NDK와 승인된 개발용 서명 설정 및 작업별 실행 경계를 먼저 준비한다.

`scripts/build-local-android.mjs` は、既存の Windows SDK・開発用署名環境に合わせたツールです。新しい PC でそのまま実行する汎用インストーラーやデスクトップ用リモートアダプターではありません。共用デスクトップではこのスクリプトをそのまま転送・実行せず、SDK・JDK・NDK、承認済み開発用署名設定、作業別の実行境界を先に準備します。

명시적으로 로컬 빌드할 때는 다음 명령을 사용한다.

明示的にローカルビルドする場合は、次のコマンドを使用します。

```powershell
npm.cmd run build:local:android
```

현재 스크립트는 기존 개발용 package·공개 API·Expo 프로젝트 값과 개인 SDK 경로·lockfile 해시·인증서 지문에 의존한다. 개인 설정은 기본적으로 `%LOCALAPPDATA%/TranslaCat/android-development-signing` 아래의 별도 파일에서 읽고, 선택적으로 `TRANSLACAT_PRIVATE_ANDROID_DIR`를 사용한다. 이 파일의 값이나 키를 소스 설정으로 옮기지 않는다.

現在のスクリプトは、既存の開発用 package・公開 API・Expo プロジェクト値、個人 SDK パス・lockfile ハッシュ・証明書フィンガープリントに依存します。個人設定は通常 `%LOCALAPPDATA%/TranslaCat/android-development-signing` 以下の別ファイルから読み、任意で `TRANSLACAT_PRIVATE_ANDROID_DIR` を使います。これらのファイルの値や鍵をソース設定へ移しません。

ARM64 Android용 release APK에 JavaScript bundle을 포함하며 EAS 클라우드 빌드를 요청하지 않는다. 생성된 `android/`와 기존 의존성을 재사용하고, prebuild가 바꾼 `package.json`은 원문으로 복원한다. 기존 개발 앱과의 서명 일치·소스 해시를 확인한 뒤 APK를 내보내며 실제 업데이트 설치는 별도로 확인한다.

ARM64 Android 用 release APK に JavaScript bundle を含め、EAS クラウドビルドはリクエストしません。生成済みの `android/` と既存依存関係を再利用し、prebuild が変更した `package.json` は元の内容へ戻します。既存開発アプリとの署名一致・ソースハッシュを確認してから APK を出力し、実際の更新インストールは別途確認します。

결과와 소스 해시는 현재 workspace의 `.codex-workspace/verification/` 아래에 보존한다. 작업별 출력 위치는 `TRANSLACAT_LOCAL_BUILD_TASK_ROOT`로 지정할 수 있다. 기존 native 출력의 소유 기록이 없거나 lockfile·필수 개인 입력이 맞지 않으면 중단한다. 자세한 준비 경계는 [로컬 빌드 운영 기록 / ローカルビルド運用記録](https://github.com/krumichan/CatPjt-TranslaCat-docs/blob/main/repositories/mobile/docs/android-local-build-20261022.md)을 따른다.

結果とソースハッシュは現在の workspace の `.codex-workspace/verification/` 以下に保管します。作業別の出力先は `TRANSLACAT_LOCAL_BUILD_TASK_ROOT` で指定できます。既存 native 出力の所有記録がない場合や、lockfile・必須の個人入力が一致しない場合は中断します。詳しい準備範囲は上記のローカルビルド運用記録に従います。

## Git 업로드 준비 / Git アップロードの準備

소스·필수 에셋·공개 설정·플러그인·빌드 스크립트·테스트와 lockfile을 관리한다. `.gitignore`와 `.easignore`는 의존성, Expo 상태, 생성된 `android/`·`ios/`, 캐시, APK·AAB·IPA와 로컬 자격 파일을 제외한다. `.env.example`은 공개 설정 예제로 남긴다. 제외 규칙은 기존 로컬 파일을 삭제하지 않는다.

ソース・必須アセット・公開設定・プラグイン・ビルドスクリプト・テスト・lockfile を管理します。`.gitignore` と `.easignore` は依存関係、Expo 状態、生成済み `android/`・`ios/`、キャッシュ、APK・AAB・IPA、ローカル認証ファイルを除外します。`.env.example` は公開設定例として残します。除外ルールで既存のローカルファイルを削除することはありません。

`.easignore`가 있으면 EAS는 `.gitignore` 대신 해당 파일을 사용하므로 두 제외 목록을 함께 관리한다. `.gitattributes`와 `.editorconfig`는 텍스트의 LF·UTF-8 편집·공백 2칸 기준과 바이너리 에셋 보존 규칙을 정한다. 기존 소스 전체를 일괄 변환하는 명령은 포함하지 않는다.

`.easignore` がある場合、EAS は `.gitignore` の代わりにそのファイルを使うため、両方の除外一覧を管理します。`.gitattributes` と `.editorconfig` はテキストの LF・UTF-8 編集・スペース 2 個の基準と、バイナリアセットの保持ルールを定めます。既存ソース全体を一括変換するコマンドは含みません。

실제 업로드 전에는 대상 파일 목록과 자격 파일 제외를 확인한다. Git 초기화·원격 연결·스테이징·커밋·푸시는 별도 사용자 지시 범위에서 수행하고, 앱 빌드나 APK 배포와 구분한다.

実際のアップロード前に対象ファイル一覧と認証ファイルの除外を確認します。Git 初期化・リモート接続・ステージング・コミット・push は別途のユーザー指示の範囲で実施し、アプリのビルドや APK 配布とは区別します。

## 관련 문서 / 関連文書

다음 문서는 같은 project-cat workspace의 docs 저장소에서 관리한다. 모바일 저장소만 내려받았다면 [TranslaCat 문서 저장소 / TranslaCat 文書リポジトリ](https://github.com/krumichan/CatPjt-TranslaCat-docs)의 `repositories/mobile/docs/`와 `repositories/shared/docs/`를 참고한다.

以下の文書は同じ project-cat workspace の docs リポジトリで管理します。モバイルリポジトリだけを取得した場合は、上記の TranslaCat 文書リポジトリの `repositories/mobile/docs/` と `repositories/shared/docs/` を参照してください。

- [모바일 개발 계획 / モバイル開発計画](https://github.com/krumichan/CatPjt-TranslaCat-docs/blob/main/repositories/shared/docs/mobile-chat-push-development-plan.md)
- [개발자 계정 준비 / 開発者アカウントの準備](https://github.com/krumichan/CatPjt-TranslaCat-docs/blob/main/repositories/mobile/docs/phase0-account-setup.md)
- [기기별 로그인과 채팅 연결 / 端末別ログインとチャット接続](https://github.com/krumichan/CatPjt-TranslaCat-docs/blob/main/repositories/mobile/docs/phase1-session-chat-integration.md)
- [방 관리 / ルーム管理](https://github.com/krumichan/CatPjt-TranslaCat-docs/blob/main/repositories/mobile/docs/mobile-room-management-20261021.md)
- [ID 초대 / ID 招待](https://github.com/krumichan/CatPjt-TranslaCat-docs/blob/main/repositories/mobile/docs/mobile-id-invitations-20261022.md)
- [관리 화면 실시간 갱신 / 管理画面のリアルタイム更新](https://github.com/krumichan/CatPjt-TranslaCat-docs/blob/main/repositories/mobile/docs/mobile-management-realtime-20261022.md)
- [알림·무음·배지 / 通知・ミュート・バッジ](https://github.com/krumichan/CatPjt-TranslaCat-docs/blob/main/repositories/mobile/docs/mobile-notification-controls-20261022.md)
- [사용자 차단 / ユーザーブロック](https://github.com/krumichan/CatPjt-TranslaCat-docs/blob/main/repositories/mobile/docs/mobile-user-blocks-20261022.md)
- [운영 문의 / 運営への問い合わせ](https://github.com/krumichan/CatPjt-TranslaCat-docs/blob/main/repositories/mobile/docs/mobile-support-20261022.md)
- [신고·탈퇴 계약 / 通報・退会の契約](https://github.com/krumichan/CatPjt-TranslaCat-docs/blob/main/repositories/mobile/docs/mobile-safety-deletion-20261023.md)
- [문자 배치 점검 / 文字レイアウト点検](https://github.com/krumichan/CatPjt-TranslaCat-docs/blob/main/repositories/mobile/docs/mobile-text-layout-audit-20261022.md)
- [GitHub 모바일 개발 프로젝트 / GitHub モバイル開発プロジェクト](https://github.com/users/krumichan/projects/12)

일회성 원본·로그·검증 결과는 docs나 모바일 저장소에 추가하지 않고 현재 workspace의 `.codex-workspace/verification/`에서 관리한다.

一時的な原本・ログ・検証結果は docs やモバイルリポジトリへ追加せず、現在の workspace の `.codex-workspace/verification/` で管理します。
