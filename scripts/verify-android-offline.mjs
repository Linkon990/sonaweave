import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;

if (!sdkRoot) {
  throw new Error("ANDROID_HOME or ANDROID_SDK_ROOT must point to the Android SDK.");
}

const buildToolsRoot = path.join(sdkRoot, "build-tools");
const executableName = process.platform === "win32" ? "aapt2.exe" : "aapt2";
const buildToolsVersions = readdirSync(buildToolsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
const aapt2Path = buildToolsVersions
  .map((version) => path.join(buildToolsRoot, version, executableName))
  .find((candidate) => existsSync(candidate));

if (!aapt2Path) {
  throw new Error(`Unable to find ${executableName} under ${buildToolsRoot}.`);
}

const apkPath = path.join(
  projectRoot,
  "android",
  "app",
  "build",
  "outputs",
  "apk",
  "debug",
  "app-debug.apk",
);

if (!existsSync(apkPath)) {
  throw new Error(`Debug APK not found: ${apkPath}`);
}

const permissionDump = execFileSync(aapt2Path, ["dump", "permissions", apkPath], {
  encoding: "utf8",
});
const permissions = [...permissionDump.matchAll(/uses-permission: name='([^']+)'/g)].map(
  ([, permission]) => permission,
);

if (permissions.includes("android.permission.INTERNET")) {
  throw new Error("Offline invariant failed: the APK declares android.permission.INTERNET.");
}

const requiredAudioPermissions = [
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.RECORD_AUDIO",
];
const missingAudioPermissions = requiredAudioPermissions.filter(
  (permission) => !permissions.includes(permission),
);

if (missingAudioPermissions.length > 0) {
  throw new Error(`The APK is missing required audio permissions: ${missingAudioPermissions.join(", ")}`);
}

console.log(`Offline APK verification passed. Declared permissions: ${permissions.join(", ")}`);
