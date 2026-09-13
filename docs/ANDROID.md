# Android 开发说明

从 `sonaweave-web` 项目根目录执行本页命令。当前版本为 **0.2.3 / versionCode 7**，应用 ID 为 `com.sonaweave.app`。工程使用根目录共享 Web 源码和 `android/` 容器。

## 环境与兼容性

开发需要 Node.js 22.12+（推荐 Node.js 24 LTS，本次使用 24.16.0）、JDK 21、Android SDK Platform 36、Build Tools 和 Platform Tools。Capacitor CLI 8 要求 Node 22+，Vite 8 在 22 系列要求至少 22.12；不要使用早期 Node 20 或 22.0 版本。`.node-version` 选择 22 系列，Android Studio 可选。

设置 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT` 指向 SDK，`JAVA_HOME` 指向 JDK 21。本机 SDK 路径写入 `android/local.properties`，不提交到 Git。Windows 构建请使用项目脚本，它会通过 Java 启动 Gradle，避免父目录 Unicode 路径影响批处理脚本。

设备最低要求为 Android 7.0（`minSdk=24`），编译与目标 SDK 均为 36。Capacitor 配置明确设置 `minWebViewVersion: 111`：设备还必须具备 Android System WebView 111+，旧版应更新 WebView；仅 Android 系统版本达标不保证可运行。该要求不代表 App 运行时要联网。

## 构建与安装

```bash
npm ci
npm test
npm run android:debug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

`android:debug` 会依次构建 Web 资源、同步 Capacitor、生成 Debug APK，并检查最终权限。安装前开启手机开发者选项与 USB 调试，确认 `adb devices` 显示 `device`；安装后核对版本为 0.2.2。

要在 Android Studio 中打开已同步的工程：

```bash
npm run android:open
```

2026-09-12 第二轮项目单元测试为 190 项，`npm audit` 无已知漏洞。依赖 override 限定在 `xcode -> uuid@11.1.1`，不全局替换其他包的 uuid。Web 项目有独立的 29 项 Playwright 测试，使用本机 Chrome 和本地测试服务器；Android 本项目的设备检查使用下述 smoke 脚本。

## 权限与本地处理

- `RECORD_AUDIO`：首次麦克风接收时申请的运行时权限。
- `MODIFY_AUDIO_SETTINGS`：WebView 音频采集所需普通权限，不产生单独弹窗；不能因为系统已允许麦克风就移除它。
- 成品不声明 `INTERNET`；`android:debug` 自动检查，亦可单独运行 `npm run android:verify-offline`。
- 消息、录音、算法与音频文件均在本机处理，WAV 导出通过应用缓存和系统分享面板完成。
- 原始 PCM 录音优先使用 AudioWorklet，兼容回退为 ScriptProcessor；两条路径都不引入 Opus/AAC 有损压缩。
- 支持 Screen Wake Lock 时，仅在前台录音期间尽力防止息屏；拒绝不会阻断录音，结束或取消会释放，不新增 Manifest 权限。

## 接收操作与排查

0.2.2 默认主页面为FSK/DTMF，顶部切换到ggwave副页面，两页共享消息草稿和样例。ggwave较慢/标准/较快三档，默认标准（4帧/组），单遍播放，收到完整消息自动停麦；FSK/DTMF播放完需手动停止分析。用副页面的录音WAV和JSON留证，切换协议页面前先导出需要保存的录音。详见[ggwave使用说明](GGWAVE.md)。

设备实际声音处理、输入路由、频响与回声都可能影响接收，安静环境不能排除这些因素。音量只代表声音，不代表载波。失败时导出实际录音比继续猜频率更有诊断价值。

录音最长 120 秒，达到上限自动分析；文件导入限 32 MB 和 120 秒。保持页面前台，取消或中断后重新完整接收。
## 验证范围

已连接设备后执行：

```bash
npm run android:smoke
```

脚本检查新版 WebView 麦克风启动/停止、三速度 ggwave 回环、三速度×48/44.1 kHz 数字流经真实 Worklet/Worker 自动接收、深浅色/大字体/横屏布局，并保留旧 FSK/DTMF 验收。麦克风取得采样、算法回环通过、文件还原成功，都不能替代两台实体设备之间的空气链路成功率测试。

当前同步保留分数采样周期，并跟踪 SWP-1 波形包络的局部边界；发送协议未改变。固定样本覆盖 16/44.1/48 kHz 采样率、前置干扰、有限噪声/回声和 ±0.3% 时钟偏差，其中偏差回归包含 480 UTF-8 字节 FSK 帧及 96 字节 DTMF 帧。该方法不是通用连续时钟恢复；实体扬声器、麦克风、距离和房间组合的成功率仍待实测。

真机验证应记录设备与 WebView 版本、发送模式、消息长度、距离、音量、噪声环境及多次接收成功数，并保留匿名 PCM WAV 样本以便复现。

## 发布

日常脚本生成 Debug APK。正式分发前需单独生成并保管签名密钥、配置 Release 构建，并完成多台真机测试；应用商店需要时再输出 AAB。签名密钥和本机 SDK 配置不得提交到 Git。任何发布构建都应重新检查成品不含 `INTERNET` 权限。

手机工作区固定在可见视口内，键盘弹出时收起页头、保留输入与生成按钮；设置和录音资料使用可关闭弹层。ggwave前两档需两端均为0.2.2；与原版ggwave互传选择较快。
