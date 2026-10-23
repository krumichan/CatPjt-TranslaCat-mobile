import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "@expo/env";

import { appEnvironmentForBuildProfile, inspectBuildReadiness } from "../config/build-config.cjs";

const [profile, platform] = process.argv.slice(2);
if (!["development", "device", "preview", "production"].includes(profile)
  || !["android", "ios"].includes(platform)) {
  console.error("Usage: node scripts/build.mjs development|device|preview|production android|ios");
  process.exit(1);
}
let appEnvironment;
try {
  appEnvironment = appEnvironmentForBuildProfile(profile, platform);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// Expo 설정과 동일하게 환경을 읽되 요청한 profile이 로컬 기본값에 가려지지 않게 한다.
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
loadProjectEnv(projectRoot, { silent: true });
const buildEnv = { ...process.env, EXPO_PUBLIC_APP_ENV: appEnvironment, EAS_BUILD_PROFILE: profile, EAS_NO_VCS: "1" };
if (platform === "android" && buildEnv.GOOGLE_SERVICES_JSON) {
  console.error("초기 클라우드 빌드는 GOOGLE_SERVICES_JSON을 EAS File 변수로 주입합니다. 로컬 경로 설정은 비워 주세요.");
  process.exit(1);
}
const readiness = inspectBuildReadiness(buildEnv, { cloud: true, profile, platform, projectRoot });
if (readiness.errors.length) {
  for (const error of readiness.errors) console.error("[ERROR] " + error);
  process.exit(1);
}
for (const waiting of readiness.waiting) console.log("[WAIT] " + waiting);

// 사전 검사가 통과한 경우에만 프로젝트에 고정된 EAS CLI를 실행한다.
const require = createRequire(import.meta.url);
const cli = require.resolve("eas-cli/bin/run");
const child = spawnSync(process.execPath, [cli, "build", "--profile", profile, "--platform", platform], {
  cwd: projectRoot,
  env: buildEnv,
  stdio: "inherit",
});
if (child.error) {
  console.error("EAS CLI를 실행하지 못했습니다. 프로젝트 의존성과 로컬 실행 권한을 확인해 주세요.");
  process.exit(1);
}
process.exit(child.status ?? 1);
