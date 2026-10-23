import Constants from "expo-constants";

type PublicExtras = {
  appEnvironment?: "development" | "preview" | "production";
  apiBaseUrl?: string | null;
  eas?: { projectId?: string };
};

const extras = Constants.expoConfig?.extra as PublicExtras | undefined;

export const runtime = {
  environment: extras?.appEnvironment ?? "development",
  apiBaseUrl: typeof extras?.apiBaseUrl === "string" && extras.apiBaseUrl.trim()
    ? extras.apiBaseUrl : null,
  projectId: Constants.easConfig?.projectId ?? extras?.eas?.projectId ?? null,
  webBaseUrl: "https://translacat.vercel.app",
};
