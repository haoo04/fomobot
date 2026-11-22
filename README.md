# Market Sentinel

多交易所行情与信号监控平台。M0 提供本地管理员登录、API 与数据库状态面板，以及后续行情接入所需的共享类型和校验契约。

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
