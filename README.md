# FuturePrice

在商品价格旁提醒你：**不买，10年后 ≈ 金额**。

例如商品 ¥100，默认 1.5 倍情景显示 ¥150（含本金）。这是帮助思考其他用途的假设，不是折扣、投资预测或收益承诺。倍数可修改，没有适合所有人的最优系数。

## Chrome 扩展 · 0.3.4 内测版

直接读取网页 DOM，逐商品显示提醒，不使用 OCR。识别依赖商品结构、可见金额、数量和价格上下文；生产代码不按购物网站域名分支。

- 支持动态改价、增删商品、购物车数量变化与站点开关。
- 购物车区分单价和行金额；无法核对的多件商品不猜金额。
- 每个网站由用户主动启用后才申请访问权限。
- 处理在本地完成，不读取 Cookie、不上传页面、不使用远程模型。

### 安装（macOS / Windows / Linux 的 Chrome）

1. 在本仓库点击 **Code → Download ZIP** 并解压，或克隆仓库。
2. 打开 `chrome://extensions`，开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择 `chrome-extension/`。
4. 打开购物页面，点击扩展图标，再点「在此网站开启」。

目前没有 Chrome Web Store 安装包。完整规则、演示和测试入口见 [扩展说明](chrome-extension/README.md)。

### 测试与打包

在仓库根目录运行（Node.js 18+；打包需 Python 3）：

```sh
node --test chrome-extension/test/rules.test.js chrome-extension/test/background.test.js chrome-extension/test/cart-totals.test.js
python3 scripts/package-chrome.py
```

打包只收录扩展运行文件和说明，生成 `output/FuturePrice-Chrome-0.3.4.zip`。截图、日志、测试夹具和浏览器数据不会进入安装包。

### 已验证与限制

0.3.4 修复购物车多件商品退回单价，以及提醒撑高后推荐区无法收起的问题。2026-10-16 完成 28 项单元测试、14 组隔离浏览器回归；Allbirds 与 Target 真实购物车的数量变化和移除已核对。详细证据范围见 [开发记录](development.md)。

这些样本不能证明适配所有购物网站。复杂折扣、缺失数量或小计、图片价格、跨域 iframe、closed shadow root、逗号小数格式等仍可能漏标。商品金额不等于含税费、运费和附加服务的最终结账扣款。尚无市场覆盖率、功耗或性能达标结论。

## Android 开发实验

`app/` 使用 Kotlin、MediaProjection、本地 ML Kit 中文 OCR 和悬浮提醒；`fixture/` 是独立合成商店；`directprobe/` 是独立无障碍节点读取实验，不是产品默认路径。

Android 尚未完成真实购物 App 与真机验收，不作为正式可用版本宣传。环境、构建与操作见 [Android 开发说明](docs/android.md)，历史验证见 [验证记录](docs/verification.md)。

## 仓库内容

- `chrome-extension/`：Chrome 扩展、合成样本与结构回放测试。
- `app/`、`fixture/`、`directprobe/`：Android 产品与隔离实验。
- `scripts/`：本地构建、验证、打包入口。
- `docs/`：验收范围与行为研究依据。
- `development.md`：CC 与 Codex 的实现、验证和剩余限制记录。

安装包、真实购物截图、原始调试记录、浏览器配置及密钥不纳入 Git。提交问题时请描述价格结构和复现步骤，避免附带账号、地址、订单号或登录数据。
