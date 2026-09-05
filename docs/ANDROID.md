# Android 开发说明

Android 版通过 Capacitor 8 复用 React/Vite 界面和 TypeScript 协议核心。Android 工程只负责 WebView 容器、录音权限和系统分享。

## 环境要求

- Node.js 20+
- JDK 21
- Android SDK Platform 36
- Android SDK Build Tools 与 Platform Tools
- Android Studio（可选，用于真机和界面调试）

设置 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT` 指向本机 Android SDK；`JAVA_HOME` 应指向 JDK 21。

## 构建

```bash
npm ci
npm test
npm run android:debug
```

`android:debug` 会依次构建 Web 资源、同步 Capacitor、生成 Debug APK，并检查最终权限。APK 位于：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

在 Android Studio 中打开工程：

```bash
npm run android:open
```

## 权限与离线边界

- `RECORD_AUDIO`：使用麦克风接收时由系统向用户申请。
- `MODIFY_AUDIO_SETTINGS`：Capacitor WebView 音频采集所需的普通权限，不产生额外弹窗。
- APK 不声明 `INTERNET`。`android:debug` 会检查成品权限，发现联网权限时构建失败。
- 编码、调制、录音解码、WAV 导入导出和数字回环均在设备本地完成。

## 真机调试

1. 在手机上开启开发者选项和 USB 调试。
2. 连接数据线并确认 `adb devices` 显示设备状态为 `device`。
3. 安装或更新 Debug APK：

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

4. 首次点击“麦克风接收”时允许录音权限。

已经连接模拟器或真机时，可以运行：

```bash
npm run android:smoke
```

该脚本会检查麦克风采集的启动和停止，并执行 FSK、DTMF 数字回环。数字回环不能替代两台实体设备之间的扬声器/麦克风测试。

## 发布说明

仓库只包含 Debug 构建配置。正式发布前需要单独生成并保管签名密钥、配置 Release 构建、输出 AAB，并在多台真机上完成声学链路测试。签名密钥和本机 SDK 配置不得提交到 Git。
