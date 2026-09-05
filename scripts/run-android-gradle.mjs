import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidRoot = path.join(projectRoot, "android");
const requestedTasks = process.argv.slice(2);
const tasks = requestedTasks.length > 0 ? requestedTasks : ["assembleDebug"];

const windowsJava = process.env.JAVA_HOME
  ? path.join(process.env.JAVA_HOME, "bin", "java.exe")
  : "java";
const command = process.platform === "win32" ? windowsJava : "./gradlew";
const args =
  process.platform === "win32"
    ? [
        "-Dorg.gradle.appname=gradlew",
        "-classpath",
        path.join("gradle", "wrapper", "gradle-wrapper.jar"),
        "org.gradle.wrapper.GradleWrapperMain",
        ...tasks,
      ]
    : tasks;

const child = spawn(command, args, {
  cwd: androidRoot,
  env: process.env,
  shell: false,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Unable to start the Android Gradle build: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Android Gradle build stopped by signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
