import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let server: MongoMemoryServer | null = null;

/**
 * 启动本地 mongod 并连接测试库；每个测试文件独立实例。
 * 默认由 mongodb-memory-server 复用/下载二进制（MONGOMS_DOWNLOAD_DIR，默认 ~/.cache/mongodb-binaries）；
 * 本地若已有系统 mongod，可用 MONGOMS_SYSTEM_BINARY 指定（该库自身会读取此环境变量）。
 */
export async function connectTestDb(): Promise<void> {
  if (mongoose.connection.readyState === 0) {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri('agent-gear-billing-test'));
  }
  await clearTestDb();
  for (const name of mongoose.modelNames()) {
    await mongoose.model(name).syncIndexes();
  }
}

export async function disconnectTestDb(): Promise<void> {
  await mongoose.disconnect();
  if (server) {
    await server.stop();
    server = null;
  }
}

export async function clearTestDb(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const collections = await db.collections();
  for (const collection of collections) {
    await collection.deleteMany({});
  }
}
