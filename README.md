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
