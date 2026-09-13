# SonaWeave（声织）

SonaWeave 是一个完全离线的近距离声学数据链路工具。Web 与 Android 共用根目录 `src/`，主页面使用 FSK / DTMF，顶部可切换到 ggwave 副页面；消息、录音和诊断资料均只在本机处理。

在线体验：[sonaweave.pages.dev](https://sonaweave.pages.dev/)

## 开发

需要 Node.js 20.19+（本机验证 24.16.0）。Android 构建还需要 JDK 21、Android SDK Platform 36。

```bash
npm ci
npm test
npm run build
npm run test:e2e
```

生产 Web 文件生成到 `dist/`。浏览器 E2E 使用本机 Chrome，并覆盖四种移动/桌面布局、明暗主题、真实 AudioWorklet/Worker 数字 PCM 流程和弹层可达性。

## Android

Android 工程位于 `android/`，使用 Capacitor 8；应用 ID 为 `com.sonaweave.app`，版本 0.2.3 / versionCode 7。

```bash
npm run android:debug
npm run android:smoke
```

Debug APK 输出到 `android/app/build/outputs/apk/debug/app-debug.apk`。`android:verify-offline` 会检查 APK 权限和网络声明；应用不需要 INTERNET 权限。不要提交 `node_modules/`、`dist/`、Gradle 缓存、同步 assets、`android/local.properties` 或签名密钥。

Android 明暗主题使用 DayNight 宿主主题，系统主题变化会重建 WebView 以保证 `prefers-color-scheme` 与系统一致。切换主题时正在进行的录音可能被系统重建中断。

## 协议与使用

- ggwave 最多 140 个 UTF-8 字节，较慢/标准/较快分别使用 5/4/3 帧分组；两端都更新到 0.2.2 后可使用全部档位。
- FSK / DTMF 保留 SWP-1、LZW12、CRC16 和 Hamming 兼容链路。
- 录音最长 120 秒；成功和失败录音都可回听、导出 WAV 与诊断 JSON。
- 数字自检和模拟器 PCM 注入不能代表实体手机经空气传输的成功率。

实现说明见 `docs/GGWAVE.md`、`docs/PROTOCOL.md`、`docs/ANDROID.md` 和 `THIRD_PARTY_NOTICES.md`。

[MIT License](LICENSE)
