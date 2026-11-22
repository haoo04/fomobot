# M0 工程基座实施计划

以产品需求和技术架构第 17 节的 M0 为交付范围，为市场接入阶段准备可运行、可验证的工程基座。

## 实施步骤

1. 建立 npm workspaces、TypeScript strict 项目引用，以及 ESLint、Prettier 和 Vitest 命令。
2. 定义行情、策略和 HTTP 共享契约。搭建 Fastify 应用、React 控制面板、存活与就绪检查。
3. 用 Drizzle 管理 SQLite 初始迁移。启用 WAL、外键和写入等待。实现单管理员初始化、Argon2id 密码、带有效期的会话、写接口来源检查、日志脱敏和 AES-256-GCM 密文存储。
4. 在 Windows 上用空库验证迁移和启动，执行鉴权、密文及 API 集成测试，再运行类型检查、lint、格式检查和构建。
5. 核对暂存内容，提交已验证的初始化改动并记录验证结果。

## 实施约定

- 按最新需求使用 npm 11 workspaces。运行时使用本机的 Node.js 26 LTS，其内置 SQLite 和 Argon2id。Drizzle 的 Node SQLite 驱动固定到已发布的 RC 版本。
- 管理员通过本机命令创建。开发环境由 Vite 转发同源 API 请求，生产环境需要同源 HTTPS 代理。
- 依赖由用户在本机执行 `npm.cmd install` 安装。提交安装生成的 `package-lock.json`。
- 交易所 REST / WebSocket 接入、策略计算、Telegram 与 OpenAI 接入安排在后续里程碑。M0 的就绪检查覆盖本地数据库。

## 验收结果

- 在临时空库验证初始迁移和重复执行，确认 WAL、外键及迁移记录。
- Vitest 的 5 项集成测试通过，覆盖健康检查、统一错误、管理员会话、来源校验、限流和密文存储。
- TypeScript 类型检查、ESLint、Prettier 检查、Drizzle 迁移检查和生产构建通过。
- `npm.cmd run dev` 同时启动 Web 和 API。通过 Vite 代理验证健康检查与认证流程，用 Edge 验证登录、两个状态指示、刷新保留会话和登出。
