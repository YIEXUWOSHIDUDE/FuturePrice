# Android 开发说明

这是开发实验，不是完成真机验收的正式产品。产品 `app/` 仍使用 OCR；节点直读位于独立 `directprobe/`，没有悄悄扩大产品权限。

## 环境

- Java 21、Android SDK Platform 35、Build Tools 35.0.0。
- 仓库使用 Gradle Wrapper 8.9、AGP 8.7.3、Kotlin 2.0.21，最低 Android 14。
- 既有验证环境：Apple Silicon Mac、Android 15 / API 35 ARM64 模拟器。

```sh
source scripts/android-env.sh
./scripts/verify-android.sh
```

环境脚本默认使用 macOS 的 `~/Library/Android/sdk` 和 Homebrew Java 21；其他路径请先设置 `ANDROID_HOME` 与 `FUTUREPRICE_JAVA_HOME`。脚本仅影响当前 shell，包含原验证环境使用的 Java IPv6 优先选项，可用已有 `JAVA_TOOL_OPTIONS` 的同名选项覆盖。

`./scripts/android-emulator.sh` 要求本机已经创建名为 `FuturePrice_API35_ARM64` 的虚拟设备；它不会安装 SDK 或创建 AVD，也不是所有平台通用的环境安装器。

## 安装与运行

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r fixture/build/outputs/apk/debug/fixture-debug.apk
```

打开 FuturePrice，按界面授予悬浮窗和使用情况访问权限，点击开启提醒，确认系统全屏共享，再打开测试商店。Debug 支持测试商店，Release 不提供这个入口。Release 构建未签名，不作为安装包交付。

首页或通知的停止按钮会结束采集；锁屏后需要重新授权。画面与 OCR 在设备本地处理，不保存或上传商品和账号信息。功能权限与实测边界见 [验收清单](acceptance.md)。

## 回归入口

```sh
./scripts/verify-android.sh
./scripts/verify-ocr-snapshots.sh --offline
./gradlew :directprobe:testDebugUnitTest :directprobe:assembleDebug :directprobe:lintDebug
```

OCR 快照脚本需要已连接的测试设备，会安装 Debug 和测试 APK 并中断原采集会话；之后重新授权。输入图片是合成商店，不是用户购物截图。节点读取实验尚有弹窗后旧标记不能及时撤下的阻塞，不能替代产品 OCR。

过去的实测结论和未通过项见 [验证记录](verification.md)。模拟器构建与有限游客页测试，不等于真机兼容性、延迟或功耗验收。
