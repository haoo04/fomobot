import { loginRequestSchema } from '@market-sentinel/contracts';
import { buildApp } from './app.js';
import { initializeAdministrator } from './auth.js';
import {
  databasePath,
  loadLocalEnvironment,
  readConfig,
  SetupError,
} from './config.js';
import { migrateDatabase, openDatabase } from './database.js';
import { createMarketData } from './market-data/service.js';

const administratorCredentialsSchema = loginRequestSchema.extend({
  password: loginRequestSchema.shape.password.min(12),
});

async function main() {
  loadLocalEnvironment();
  const command = process.argv[2] ?? 'serve';
  if (!['serve', 'migrate', 'admin:init'].includes(command)) {
    throw new SetupError('支持的命令为 serve、migrate 和 admin:init。');
  }

  const config = command === 'serve' ? readConfig() : null;
  const database = openDatabase(databasePath());
  let listening = false;

  try {
    migrateDatabase(database);
    if (config) {
      const marketData = createMarketData(database);
      const app = await buildApp(database, config, marketData);
      app.addHook('onReady', async () => marketData.start());
      app.addHook('onClose', async () => database.$client.close());
      await app.listen({ host: config.HOST, port: config.PORT });
      listening = true;

      const stop = () => {
        void app.close().catch(() => {
          console.error('服务关闭失败。');
          process.exitCode = 1;
        });
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    } else if (command === 'admin:init') {
      const credentials = administratorCredentialsSchema.safeParse({
        username: process.env.ADMIN_USERNAME ?? 'admin',
        password: process.env.ADMIN_PASSWORD,
      });
      delete process.env.ADMIN_PASSWORD;
      if (!credentials.success) {
        throw new SetupError(
          '请设置 ADMIN_PASSWORD（12–128 个字符），并检查 ADMIN_USERNAME。',
        );
      }
      if (!(await initializeAdministrator(database, credentials.data))) {
        throw new SetupError('管理员已初始化。');
      }
      console.log('管理员已创建。');
    } else {
      console.log('SQLite 迁移已完成。');
    }
  } finally {
    if (!listening) database.$client.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof SetupError
      ? error.message
      : '操作失败。请检查 SQLite 路径、迁移文件和监听地址。',
  );
  process.exitCode = 1;
});
