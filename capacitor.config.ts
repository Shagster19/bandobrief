import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.bandobrief.app",
  appName: "BandoBrief",
  webDir: "dist",
  bundledWebRuntime: false,
  backgroundColor: "#f4f7f3",
  loggingBehavior: "debug",
  android: {
    backgroundColor: "#f4f7f3",
    allowMixedContent: false
  },
  ios: {
    backgroundColor: "#f4f7f3",
    contentInset: "automatic",
    preferredContentMode: "mobile"
  }
};

export default config;
