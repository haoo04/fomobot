import { resolve } from 'node:path';
import { loginRequestSchema } from '@market-sentinel/contracts';
import { buildApp } from './app.js';
import { initializeAdministrator } from './auth.js';
import {
  databasePath,
  loadLocalEnvironment,
  readConfig,
  SetupError,
} from './config.js';
import { migrateDatabase, openDatabase, restoreDatabase } from './database.js';
import { createMarketData } from './market-data/service.js';

const administratorCredentialsSchema = loginRequestSchema.extend({
  password: loginRequestSchema.shape.password.min(12),
});

async function main() {
  loadLocalEnvironment();
  const command = process.argv[2] ?? 'serve';
  if (command === 'restore') {
    const [source, destination] = process.argv.slice(3);
    const pathKey = (path: string) =>
      process.platform === 'win32'
        ? resolve(path).toLowerCase()
        : resolve(path);
    if (
      !source ||
      !destination ||
      pathKey(destination) === pathKey(databasePath())
    )
      throw new SetupError('请提供备份文件及不同于当前数据库的新文件路径。');
    try {
      await restoreDatabase(source, destination);
    } catch {
      throw new SetupError(
        '恢复失败。请检查备份完整性、目标目录权限及目标文件是否已存在。',
      );
    }
    console.log('已恢复至新的 SQLite 文件。');
    return;
  }
  if (!['serve', 'migrate', 'admin:init'].includes(command)) {
    throw new SetupError(
      '支持的命令为 serve、migrate、restore 和 admin:init。',
    );
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
