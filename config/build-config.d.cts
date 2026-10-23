import type { ExpoConfig } from 'expo/config';

export type AppEnvironment = 'development' | 'preview' | 'production';
export type BuildProfile = 'development' | 'device' | 'preview' | 'production';
export type BuildEnvironment = Record<string, string | undefined>;

export interface BuildReadiness {
  appEnvironment: string;
  ready: string[];
  waiting: string[];
  errors: string[];
}

export function appEnvironmentForBuildProfile(profile: string, platform?: string): AppEnvironment;

export function buildAppConfig(env?: BuildEnvironment): ExpoConfig & {
  extra: {
    appEnvironment: AppEnvironment;
    apiBaseUrl?: string;
    eas?: { projectId: string };
  };
};

export function inspectBuildReadiness(env?: BuildEnvironment, options?: {
  profile?: BuildProfile;
  cloud?: boolean;
  platform?: 'android' | 'ios' | 'all';
  projectRoot?: string;
}): BuildReadiness;
