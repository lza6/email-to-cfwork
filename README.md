
# 📬 AI Mail Dashboard (智能邮件 AI 看板)

基于 Cloudflare Workers 和大模型（如 DeepSeek）构建的无服务器自动化邮件总结看板。
本项目完美解决了长文超限、API 超时（524错误）、Cloudflare KV 写入限流等生产级痛点，提供了一个开箱即用、极致丝滑的现代邮件管理体验。

## ✨ 核心特性

- **⚡ 毫秒级防阻塞接收**：利用 Cloudflare Email Routing，邮件到达瞬间响应，杜绝因大模型处理慢导致的邮件重试死循环。
- **🛡️ 完美绕过 KV 写入限制**：采用 `ctx.waitUntil` 挂起后台异步任务，配合前端状态机静默轮询，彻底告别写爆数据库和封号风险。
- **🧠 智能长文切片 (Map-Reduce)**：如果遇到几十万字的代码报错或超长邮件，系统会自动分段提取并进行全局汇总，拒绝生硬截断。
- **🎨 现代企业级 UI**：基于 Vue3 + Tailwind CSS 构建单页应用（SPA）。自带优雅的骨架屏（Skeleton）、自动状态同步和 Markdown 实时渲染。
- **🌍 纯正的中文支持**：重写了底层的 Base64 解析逻辑，完美解码各种复杂的国内邮箱（如 QQ、网易）的 UTF-8 编码，告别乱码。

---

## 🛠️ 准备工作

在开始部署之前，你需要准备好以下三样东西：
1. **一个 Cloudflare 账号**（并且在里面托管了一个你自己的域名）。
2. **一个大模型的 API 密钥**（本项目默认支持 OpenAI 兼容接口，强烈推荐 DeepSeek-V3 / R1 或其他支持大上下文的模型）。
3. **一个浏览器**。

---

## 🚀 部署指南（5 分钟完成）

请按照以下步骤，在你的 Cloudflare 中将本项目跑起来：

### 第一步：创建 KV 数据库
本项目使用 Cloudflare KV 作为轻量级数据和状态存储引擎。
1. 登录 Cloudflare 控制台，点击左侧菜单的 **存储与数据库 (Storage & Databases)** -> **KV**。
2. 点击 **创建命名空间 (Create namespace)**。
3. 命名空间名称**必须**填写为：`MAIL_SUMMARY_KV`，然后点击添加。

### 第二步：创建并配置 Worker
1. 在左侧菜单点击 **计算 (Compute)** -> **Workers 和 Pages (Workers & Pages)**。
2. 点击 **创建应用程序 (Create application)** -> **创建 Worker**。
3. 给你的 Worker 起个名字（比如 `ai-mail-bot`），然后点击 **部署**。
4. 部署成功后，点击 **编辑代码 (Edit code)**，将本项目中 `worker.js` 的所有代码复制进去，完全覆盖自带的代码，点击右上角的 **部署**。

### 第三步：绑定数据库与环境变量（关键步骤）
回到刚才创建的 Worker 的管理页面：
1. **绑定 KV**：
   - 点击 **设置 (Settings)** -> **绑定 (Bindings)**。
   - 点击 **添加绑定** -> 选择 **KV 命名空间**。
   - **变量名称** 填入 `MAIL_SUMMARY_KV`，在右侧下拉框选择你第一步创建的那个 KV 空间。点击保存。
2. **配置环境变量**：
   - 切换到 **变量 (Variables)** 选项卡，添加以下三个环境变量：
     - `API_URL`：填入你的大模型接口地址（例如：`https://api.deepseek.com/v1/chat/completions` 或者你在用的第三方接口）。
     - `API_KEY`：填入你的大模型密钥（**强烈建议点击“加密”按钮**）。
     - `MODEL_NAME`：填入你要调用的模型名称（例如：`deepseek-chat`）。

### 第四步：设置电子邮件路由 (Email Routing)
让收到的邮件自动发送给我们的 AI！
1. 在 Cloudflare 控制台点击左侧的 **电子邮件 (Email)** -> **电子邮件路由 (Email Routing)**。
2. 确保你的域名已经启用了邮件路由功能。
3. 切换到 **路由规则 (Routing rules)** 选项卡。
4. 点击 **创建地址 (Create address)**：
   - **自定义地址**：设置一个你喜欢的邮箱前缀（例如 `ai@yourdomain.com`）。
   - **操作 (Action)**：选择 **发送到 Worker (Send to a Worker)**。
   - 在下拉菜单中选择你刚才创建的 `ai-mail-bot`。
5. 点击保存！

---

## 💻 访问与使用

大功告成！现在你可以开始测试了：

1. 打开你的常用邮箱（Gmail、QQ、Outlook等），给你的专属地址 `ai@yourdomain.com` 发送一封测试邮件。
2. 回到 Cloudflare 的 Worker 管理页面，在右上角找到类似于 `https://ai-mail-bot.xxx.workers.dev` 的链接（建议在“触发器”里绑定一个你自己的自定义域名，访问更稳定）。
3. 在浏览器打开该链接，你将看到漂亮的 AI 智能看板。
4. 页面会自动静默刷新，你会看到新邮件出现并带有 **“⚡ AI 思考中”** 的标志，等待几秒后，完美的 Markdown 总结就会呈现在你眼前！

---

## 🧠 架构揭秘（为什么这么稳？）

很多新手在开发此类工具时，会遇到 Cloudflare KV `1次/秒` 的写入限制导致报错 524，或者把整个邮件列表存成一个巨型 JSON 导致内存溢出。

本项目采用了**工业级的妥协设计**：
- **读写分离机制**：`email_index` 仅存储不到 1KB 的轻量索引状态，邮件正文和 AI 总结独立拆分为 `body_{id}` 和 `summary_{id}` 存储，按需拉取。
- **异步非阻塞**：Worker 接到邮件后立刻响应邮件服务器（耗时 < 50ms），将 AI 总结任务通过 `ctx.waitUntil()` 转移至后台线程，彻底解决 API 超时断联的问题。

---
