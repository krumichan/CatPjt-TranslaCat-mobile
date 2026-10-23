import type { ExpoConfig } from 'expo/config';
import { buildAppConfig } from './config/build-config.cjs';

// Expo가 TS 설정 파일을 읽을 때 추가 TS 모듈 로더를 요구하지 않게 CJS 경계를 사용한다.
export default (): ExpoConfig => buildAppConfig(process.env);
