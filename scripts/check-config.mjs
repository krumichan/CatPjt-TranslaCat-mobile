import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from '@expo/env';
import { inspectBuildReadiness } from '../config/build-config.cjs';

const args = process.argv.slice(2);
let cloud = false;
let platform = 'all';
let profile;

// 설정 검사만 수행한다. EAS 로그인, 프로젝트 생성, 원격 자격 조회는 실행하지 않는다.
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--cloud') cloud = true;
  else if (argument === '--platform' && args[index + 1]) platform = args[++index];
  else if (argument.startsWith('--platform=')) platform = argument.slice('--platform='.length);
  else if (argument === '--profile' && args[index + 1]) profile = args[++index];
  else if (argument.startsWith('--profile=')) profile = argument.slice('--profile='.length);
  else {
    console.error('Usage: npm run config:check -- [--cloud] [--profile development|device|preview|production] [--platform android|ios|all]');
    process.exit(1);
  }
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
loadProjectEnv(projectRoot, { silent: true });
const result = inspectBuildReadiness(process.env, {
  cloud,
  profile,
  platform,
  projectRoot,
});

console.log(`TranslaCat ${cloud ? 'cloud prerequisites' : 'local configuration'} check`);
for (const message of result.ready) console.log(`[READY] ${message}`);
for (const message of result.waiting) console.log(`[WAIT] ${message}`);
for (const message of result.errors) console.error(`[ERROR] ${message}`);
process.exitCode = result.errors.length ? 1 : 0;
