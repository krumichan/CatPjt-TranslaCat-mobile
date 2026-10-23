import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const workspace = path.dirname(path.resolve(repoRoot));
const privateRoot = process.env.TRANSLACAT_PRIVATE_ANDROID_DIR
  || path.join(process.env.LOCALAPPDATA || "", "TranslaCat/android-development-signing");
const hash = (filename) => crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error || result.status !== 0) throw new Error(`Local build command failed: ${path.basename(command)} (${result.status ?? "not started"})`);
}

function sourceFiles() {
  // 소스만 사본에 반영한다. 로컬 환경·서명키·네이티브 출력·의존성은 포함하지 않는다.
  const files = [];
  const roots = new Set(["assets", "config", "plugins", "scripts", "src", "tests"]);
  const topFiles = new Set([".easignore", ".env.example", ".gitignore", "AGENTS.md", "app.config.ts", "eas.json",
    "eslint.config.js", "expo-env.d.ts", "package-lock.json", "package.json", "README.md", "tsconfig.json"]);
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(repoRoot, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected source link: ${child}`);
      if (/^(node_modules|\.git|\.expo|android|ios|dist|coverage)$/.test(entry.name)) continue;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) {
        if (/^\.env/.test(entry.name) && entry.name !== ".env.example") continue;
        if (/^(credentials|google-services)\.json$|\.(jks|keystore|p8|p12|mobileprovision|log)$/i.test(entry.name)) continue;
        files.push(child);
      }
    }
  };
  for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && roots.has(entry.name)) visit(entry.name);
    else if (entry.isFile() && topFiles.has(entry.name)) files.push(entry.name);
  }
  return files.sort().map((relative) => ({ path: relative.replaceAll("\\", "/"), sha256: hash(path.join(repoRoot, relative)) }));
}

function main() {
  if (process.platform !== "win32") throw new Error("This local build command is configured for this Windows SDK installation.");
  const settings = JSON.parse(fs.readFileSync(path.join(privateRoot, "build-settings.json"), "utf8"));
  const taskRoot = path.resolve(process.env.TRANSLACAT_LOCAL_BUILD_TASK_ROOT || settings.taskRoot);
  const verificationRoot = path.join(workspace, ".codex-workspace/verification") + path.sep;
  if (!taskRoot.startsWith(verificationRoot)) throw new Error("Build workspace must be inside the current workspace verification directory.");
  const work = path.join(taskRoot, "work");
  const signingFile = path.join(privateRoot, "signing.json");
  const googleFile = path.join(privateRoot, "google-services.json");
  for (const filename of [path.join(settings.javaHome, "bin/java.exe"), path.join(settings.sdkRoot, "build-tools/37.0.0/apksigner.bat"),
    signingFile, googleFile, path.join(repoRoot, "node_modules/expo/bin/cli")]) {
    if (!fs.existsSync(filename)) throw new Error(`Required local build input is missing: ${path.basename(filename)}`);
  }
  const signing = JSON.parse(fs.readFileSync(signingFile, "utf8"));
  if (!fs.existsSync(signing.keystorePath) || path.dirname(signing.keystorePath) !== privateRoot) throw new Error("Expected private development keystore is missing.");
  const firebase = JSON.parse(fs.readFileSync(googleFile, "utf8"));
  if (firebase.project_info?.project_id !== "translacat-mobile-dev" || firebase.private_key
    || !firebase.client?.some((c) => c.client_info?.android_client_info?.package_name === "com.krumichan.translacat.dev")) {
    throw new Error("Expected development Firebase client configuration is required.");
  }
  if (hash(path.join(repoRoot, "package-lock.json")) !== settings.dependencyLockSha256) {
    throw new Error("Dependency lock changed. Refresh the isolated dependencies before building.");
  }

  // 기존 의존성을 재사용하는 표준 Expo native 빌드 경로에 ASCII 별칭을 연결한다.
  const drive = settings.drive;
  if (!/^[F-Z]:$/.test(drive)) throw new Error("Expected an unused ASCII drive letter.");
  const aliasWork = path.join(`${drive}\\`, path.basename(path.resolve(repoRoot)));
  if (!fs.existsSync(`${drive}\\`)) run("subst.exe", [drive, workspace]);
  if (!fs.existsSync(path.join(aliasWork, "package.json"))
    || fs.realpathSync.native(path.join(aliasWork, "package.json")) !== fs.realpathSync.native(path.join(repoRoot, "package.json"))) {
    throw new Error("Build drive is already used by another directory.");
  }

  const sources = sourceFiles();
  const previousFile = path.join(taskRoot, "managed-sources.json");
  const previous = fs.existsSync(previousFile) ? JSON.parse(fs.readFileSync(previousFile, "utf8")) : [];
  for (const old of previous) {
    const destination = path.resolve(work, old.path);
    if (!destination.startsWith(work + path.sep)) throw new Error("Unsafe prior build source path.");
    if (!sources.some((source) => source.path === old.path) && fs.existsSync(destination)) fs.unlinkSync(destination);
  }
  for (const source of sources) {
    const destination = path.join(work, source.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, source.path), destination);
    if (hash(destination) !== source.sha256) throw new Error("Source snapshot changed during copy.");
  }
  fs.writeFileSync(previousFile, JSON.stringify(sources, null, 2));
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  fs.writeFileSync(path.join(taskRoot, `sources-${stamp}.json`), JSON.stringify(sources, null, 2));

  // 환경은 이 빌드 자식 프로세스에만 적용한다. 클라우드 빌드와 Metro는 실행하지 않는다.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("EXPO_PUBLIC_") || key === "EAS_BUILD") delete env[key];
  Object.assign(env, {
    JAVA_HOME: settings.javaHome, ANDROID_HOME: settings.sdkRoot, ANDROID_SDK_ROOT: settings.sdkRoot,
    PATH: `${path.join(settings.javaHome, "bin")};${path.dirname(process.execPath)};${env.PATH}`,
    EXPO_NO_DOTENV: "1", EXPO_NO_TELEMETRY: "1", EXPO_OFFLINE: "1", CI: "1", NODE_ENV: "production",
    EXPO_PUBLIC_APP_ENV: "development", EXPO_PUBLIC_API_URL: "https://217.142.230.186/api/v1", EAS_BUILD_PROFILE: "device",
    EXPO_OWNER: "kurumichans-team", EXPO_PROJECT_ID: "55b79b33-07b9-4d4b-a3f8-cf24ea76b139",
    TRANSLACAT_ANDROID_PACKAGE: "com.krumichan.translacat.dev", TRANSLACAT_IOS_BUNDLE_IDENTIFIER: "com.krumichan.translacat.dev",
    GOOGLE_SERVICES_JSON: googleFile, TRANSLACAT_ANDROID_SIGNING_FILE: signingFile, CMAKE_BUILD_PARALLEL_LEVEL: "2",
    TRANSLACAT_REAL_PROJECT_ROOT: path.resolve(repoRoot), TRANSLACAT_ALIAS_PROJECT_ROOT: aliasWork,
  });
  const nativeOwner = path.join(taskRoot, "native-project-owner.json");
  if (fs.existsSync(path.join(aliasWork, "android")) && !fs.existsSync(nativeOwner)) throw new Error("Existing native project has no local build ownership record; inspect it before reuse.");
  if (fs.existsSync(nativeOwner) && JSON.parse(fs.readFileSync(nativeOwner, "utf8")).repoRoot !== path.resolve(repoRoot)) throw new Error("Native ownership record belongs to another source directory.");
  fs.writeFileSync(nativeOwner, JSON.stringify({ repoRoot: path.resolve(repoRoot), generatedAndroid: true }));
  const originalPackage = fs.readFileSync(path.join(repoRoot, "package.json"));
  // prebuild의 package.json script 변경은 소유한 작업 결과로 기록한 뒤 원문을 복원한다.
  try {
    run(process.execPath, [path.join(aliasWork, "node_modules/expo/bin/cli"), "prebuild", "--platform", "android", "--no-install", "--no-clean",
      "--skip-dependency-update", "react,react-native,expo"], { cwd: aliasWork, env });
  } finally {
    fs.writeFileSync(path.join(taskRoot, `prebuild-package-${stamp}.json`), fs.readFileSync(path.join(repoRoot, "package.json")));
    fs.writeFileSync(path.join(repoRoot, "package.json"), originalPackage);
  }
  const android = path.join(aliasWork, "android");
  const settingsGradle = path.join(android, "settings.gradle");
  const pathsMarker = "// TranslaCat Windows local path alignment";
  const originalSettings = fs.readFileSync(settingsGradle, "utf8").split(pathsMarker)[0].trimEnd();
  fs.writeFileSync(path.join(taskRoot, `settings-before-paths-${stamp}.gradle`), originalSettings);
  // autolinking이 반환한 실제 경로와 SUBST 경로를 동일한 드라이브로 맞춘다.
  fs.writeFileSync(settingsGradle, `${originalSettings}\n\n${pathsMarker}\n` + `
def localRealRoot = System.getenv("TRANSLACAT_REAL_PROJECT_ROOT").replace('\\\\', '/')
def localAliasRoot = System.getenv("TRANSLACAT_ALIAS_PROJECT_ROOT").replace('\\\\', '/')
def localPath = { String input ->
    def normalized = input.replace('\\\\', '/')
    if (normalized.equalsIgnoreCase(localRealRoot) || normalized.toLowerCase().startsWith(localRealRoot.toLowerCase() + '/')) {
        return localAliasRoot + normalized.substring(localRealRoot.length())
    }
    return input
}
def alignDescriptor
alignDescriptor = { descriptor ->
    descriptor.projectDir = new File(localPath(descriptor.projectDir.absolutePath))
    descriptor.children.each { alignDescriptor(it) }
}
rootProject.children.each { alignDescriptor(it) }
def localAutolinking = new File(rootDir, 'build/generated/autolinking/autolinking.json')
if (localAutolinking.exists()) {
    def alignValue
    alignValue = { value ->
        if (value instanceof Map) return value.collectEntries { key, item -> [(key): alignValue(item)] }
        if (value instanceof List) return value.collect { alignValue(it) }
        if (value instanceof String) return localPath(value)
        return value
    }
    def originalAutolinking = new groovy.json.JsonSlurper().parse(localAutolinking)
    localAutolinking.text = groovy.json.JsonOutput.toJson(alignValue(originalAutolinking))
}
`);
  const appGradle = path.join(android, "app/build.gradle");
  const signingMarker = "// TranslaCat private local release signing";
  const generated = fs.readFileSync(appGradle, "utf8").split(signingMarker)[0].trimEnd();
  fs.writeFileSync(appGradle, `${generated}\n\n${signingMarker}\n` +
    `def localKey = new groovy.json.JsonSlurper().parse(new File(System.getenv("TRANSLACAT_ANDROID_SIGNING_FILE")))\n` +
    `android.signingConfigs { localDevice { storeFile file(localKey.keystorePath); storePassword localKey.storePassword; keyAlias localKey.keyAlias; keyPassword localKey.keyPassword } }\n` +
    `android.buildTypes.release.signingConfig = android.signingConfigs.localDevice\n`);
  const java = path.join(settings.javaHome, "bin/java.exe");
  run(java, ["-classpath", path.join(android, "gradle/wrapper/gradle-wrapper.jar"), "org.gradle.wrapper.GradleWrapperMain",
    ":app:assembleRelease", "--no-daemon", "--max-workers=2", "--console=plain", "-PreactNativeArchitectures=arm64-v8a",
    "-Pandroid.cmakeVersion=3.31.6", "-Pkotlin.compiler.execution.strategy=in-process"], { cwd: android, env });

  // 기존 APK와 같은 인증서인지 확인한 뒤에만 설치용 결과로 내보낸다.
  const apk = path.join(android, "app/build/outputs/apk/release/app-release.apk");
  const verifier = path.join(settings.sdkRoot, "build-tools/37.0.0/lib/apksigner.jar");
  const signature = spawnSync(java, ["-jar", verifier, "verify", "--print-certs", apk], { env, encoding: "utf8" });
  if (signature.status !== 0 || !signature.stdout.toLowerCase().includes(settings.certificateSha256.toLowerCase())) throw new Error("APK signature verification or existing certificate match failed.");
  const artifacts = path.join(taskRoot, "artifacts");
  fs.mkdirSync(artifacts, { recursive: true });
  const output = path.join(artifacts, `translacat-dev-local-${stamp}-arm64.apk`);
  fs.copyFileSync(apk, output);
  for (const source of sources) if (hash(path.join(repoRoot, source.path)) !== source.sha256) throw new Error(`Source changed during native build: ${source.path}`);
  const receipt = { builtAt: new Date().toISOString(), apk: output, sha256: hash(output), bytes: fs.statSync(output).size,
    certificateSha256: settings.certificateSha256, signatureVerified: true, package: "com.krumichan.translacat.dev",
    architecture: "arm64-v8a", sourceCount: sources.length, cloudBuild: false, deviceInstallVerified: false };
  fs.writeFileSync(path.join(taskRoot, "apk-built.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }

