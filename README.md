# FuturePrice

一个计划中的 iPhone 购物提醒工具：把当前商品价格或实付款乘以 **1.6**，提醒自己是否愿意为这次购买放弃对应的未来价值。

例如，¥100 → ¥160。¥160 已包含今天的 ¥100，不再重复相加。固定系数是个人提醒，不代表保证的投资收益，也不对应特定投资期限。

## 当前状态

项目已建立，尚未实现可安装的 iPhone App。没有完成 iPhone 编译或真机验证；临时目录中的早期草稿未纳入本仓库。

目标设备：iPhone 17 Pro，iOS 27.0.0。

2026-10-06 环境检查：当前 Mac 的 xcode-select 指向 CommandLineTools，Swift 6.3.3；未找到可用的 iPhone SDK。下一阶段首先需要完整 Xcode、对应 SDK、开发签名与真机安装条件。

## 预期体验

1. 开启一次“购物模式”，完成系统要求的屏幕共享确认。
2. 正常切换和使用购物 App，无需逐个配置、分享链接、手动截图或输入金额。
3. 在灵动岛显示当前可信金额及 ×1.6 提醒；实付款优先，明确单一商品价作为次选并标明类型。
4. 月供、优惠额、多商品或条件不明的价格不猜测。切换页面后撤下旧金额，再确认新金额。
5. 结束购物模式，停止采集与识别并结束 Live Activity。

默认不保存屏幕、不上传数据；不接入云端模型、后端服务或分析遥测。

## 候选技术路线

系统授权全屏采集 → 内存画面 → 本地 Vision OCR → 金额与页面有效性判断 → ActivityKit / 灵动岛。

- Apple 的 iOS 27 ScreenCaptureKit 示例包含系统选择器、屏幕帧回调与 screen-capture 后台模式，但没有实现后台 OCR。
- Vision 提供文字识别，ActivityKit 提供 Live Activity 呈现与更新。
- 上述能力组合后的后台连续性、实际显示延迟、旧值撤下速度、耗电和购物 App 覆盖率均未验证。
- 灵动岛的呈现由系统控制；不承诺全 App 覆盖、永久后台运行或一秒内更新。

工程上计划只处理最新画面，丢弃过时任务，屏蔽自身提醒区域，避免旧页结果迟到或识别到自己的提醒。具体实现以正式 SDK 和真机验证为准。

## 开发顺序

1. 建立最小 App 与 Live Activity 扩展，在真机打通采集 → OCR → 灵动岛。
2. 实现价格优先级、歧义拒绝、页面切换和过时结果失效规则。
3. 测量速度、连续运行和功耗，再扩展代表性购物 App 测试。

具体检查项见 [真机验收清单](docs/acceptance.md)。所有未勾选项均未完成。

## 开发边界

本目录是独立 Git 仓库。所有源码、配置和提交限定在本目录；不依赖或修改外层 Feiran 的代码、部署、数据和版本历史。Apple 示例按需参考并遵守其许可，不整体引入其压缩包或内嵌 .git。

## 官方参考

- [Capturing screen content on iOS](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios)
- [Vision text recognition](https://developer.apple.com/documentation/vision/recognizetextrequest)
- [Live Activities](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)
- [Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)
- [Personal Team 与签名限制](https://developer.apple.com/help/account/basics/about-your-developer-account)
