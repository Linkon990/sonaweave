import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.sonaweave.app",
  appName: "SonaWeave",
  webDir: "dist",
  android: {
    allowMixedContent: false,
    backgroundColor: "#edf0ed",
  },
};

export default config;
