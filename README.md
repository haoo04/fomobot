# Market Sentinel

多交易所行情与信号监控平台。控制台提供本地管理员登录、Bitget 与 Hyperliquid 行情目录、市场监控和采集诊断。

## Windows 本地启动

需要 Node.js 26 LTS、npm 11 和 PowerShell 7。仓库根目录使用 npm workspaces。

```powershell
npm.cmd install
```

首次运行时创建根目录的 `.env`，并为应用生成两把独立的随机密钥。

```powershell
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
    $appKey = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $sessionKey = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $settings = (Get-Content -LiteralPath .env -Raw).Replace('APP_ENCRYPTION_KEY_BASE64=', "APP_ENCRYPTION_KEY_BASE64=$appKey").Replace('SESSION_SECRET=', "SESSION_SECRET=$sessionKey")
    Set-Content -LiteralPath .env -Value $settings -NoNewline
}
```

迁移空库并创建管理员。用户名默认为 `admin`，可通过当前终端的 `ADMIN_USERNAME` 指定。密码长度为 12–128 个字符。

```powershell
npm.cmd run db:migrate
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host '管理员密码' -AsSecureString)).Password
try {
    npm.cmd run admin:init
} finally {
    Remove-Item Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue
}
npm.cmd run dev
```

浏览器打开 [http://localhost:5173](http://localhost:5173)。开发服务器从同一来源转发 API，Fastify 默认监听 `127.0.0.1:3001`。默认数据库为 `data/market-sentinel.sqlite`。服务启动时也会应用尚未执行的迁移。

生产设置使用 `NODE_ENV=production`、HTTPS `WEB_ORIGIN` 和同源反向代理。Web 构建产物在 `apps/web/dist`，API 用 `npm.cmd start` 启动。

## 市场监控

- 登录后打开「市场监控」，按交易所、产品类型或符号搜索。目录在启动及每 6 小时自动同步，也可手动刷新。
- 选择市场后配置触发、确认、方向和额外观察周期。默认使用 `3m`、`5m`、`1h`。可在列表中编辑、暂停、删除或批量启停。删除配置会保留该市场已采集的数据。
- 每周期尝试载入 500 根已收盘 K 线，少于 300 根含有效成交量的历史会标为预热中。页面分别显示盘中价、最近收盘、K 线缺口、点差和永续 OI 样本时间。
- Reality 的 `3m` 依赖完整的公开 REST `1m`。Bitget 日线使用 REST 的 `1Dutc`，通过该市场的 UTC 边界验证后才开放。Bitget 公共 WebSocket 最多使用 49 个频道，额外周期和行情频道共用该容量。
- 行情采集使用两家交易所的公开 REST 和 WebSocket，需要本机能访问 `api.bitget.com`、`ws.bitget.com` 和 `api.hyperliquid.xyz`。

## 策略与风控

- 在「市场监控」的监控卡片展开「策略与风控」，可独立启停策略并编辑参数。参数版本从保存后的下一根触发 K 线生效。
- 按市场填写点差、触发周期成交额、止损距离和波动阈值。阈值待配置时，交易候选会保留拒绝原因。永续需要可比较的 OI 样本，现货的偏空形态显示为观察。
- 「近期候选」显示预风控和最终风控、参考价位、配置版本、计算证据与送达详情。

## Telegram 通知

- 在「通知与 AI」保存 Bot Token，或设置环境变量 `TELEGRAM_BOT_TOKEN`。生成配对码，在 Telegram 与机器人私聊发送面板上的 `/start` 命令，再点击「发送测试消息」。
- 配对后启用规则通知。每市场每天默认最多 8 条，全局 30 条，按应用时区计日。面板设置优先于环境变量，Bot Token 更换后需要重新配对。
- 送达不确定的提醒保留审计记录。可在仍有效的候选详情里确认补发一次。

## OpenAI 审核

- AI 默认关闭。在「通知与 AI」配置 OpenAI API Key 和模型后，可先测试结构化响应，再启用审核。也可通过 `OPENAI_API_KEY`、`OPENAI_MODEL` 和 `AI_REVIEW_ENABLED` 配置。运行审核前，请按本地启动步骤手动安装仓库依赖。
- 默认模型为 `gpt-6-luna`，审核超时 10 秒，主观评分门槛 70，每日估算预算 USD 1。测试请求计入预算，模型用量和估算费用会显示在面板。
- AI 接受或修改后还需通过最终风控。候选详情可查看审核摘要、决策、费用、最终价位和 Telegram 送达记录。

## 信号历史

- 打开「信号历史」按市场、日期、策略、风控、送达或理论状态筛选。详情包含批准价位、审核、Telegram 正文、理论事件和判定所用的 K 线。CSV 导出摘要，JSON 导出详细证据，单次最多 5,000 条。
- 理论追踪从批准后的第一根完整触发周期 K 线开始，最多处理 20 根。分批止盈和止损以正式信号的参考价位计算成本前理论 R。同根触及止盈和止损时优先处理止损，并标记歧义。
- 原周期停采后，已入库的连续 K 线先结算，仍在追踪的信号标记失效。断线缺口等待回补。若行情在回补期限内仍不完整，详情显示失效原因。
- 已结束且至少 48 小时无关联活动的记录可以逐条确认删除，保留管理员删除审计。
- 「通知与 AI」可关闭默认开启的理论信号更新。更新发往收到原提醒的同一私聊，与交易提醒分开计入单市场和全局每日上限。

## 运行告警与数据库维护

- 「总览」显示当日候选、拒绝、送达和最近告警。系统健康通知默认开启，可在「通知与 AI」关闭。行情接口持续异常时产生告警，恢复后记录恢复事件。
- 服务在应用时区 03:00–05:00 内执行每日 SQLite 在线备份，验证完整性后保留最近 7 份。默认备份目录为 `data/market-sentinel.sqlite.backups`。当日备份验证通过后，服务才会分批清理旧行情。
- K 线默认保留 365 天。可设置 `CANDLE_RETENTION_DAYS_BY_TIMEFRAME` 为 JSON 对象，例如 `{"1m":90,"1d":730}`。OI 默认保留 180 天，可通过 `OI_RETENTION_DAYS` 调整。最后报价保留 30 天。清理保护活跃监控预热和未结算信号所需行情。
- 恢复命令输出一个全新数据库文件。切换服务前停止原实例，更新 `DATABASE_URL` 并沿用原加密密钥。使用原管理员账号重新登录，恢复时待发和在途消息的状态为送达不确定。

```powershell
npm.cmd run db:restore -- "data/market-sentinel.sqlite.backups/backup-2026-11-24.sqlite" "data/market-sentinel-restored.sqlite"
```

## 检查

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd test
npm.cmd run build
```

- `GET /health/live` 检查 API 进程是否响应。
- `GET /health/ready` 检查 SQLite 文件及初始表是否可查询。
- 修改数据库 schema 后运行 `npm.cmd run db:generate -- --name <migration-name>`，一起提交 SQL 和快照。
