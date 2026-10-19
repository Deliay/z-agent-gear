import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let server: MongoMemoryServer | null = null;

/** 启动本地 mongod（使用系统二进制）并连接测试库；每个测试文件独立实例。 */
export async function connectTestDb(): Promise<void> {
  if (mongoose.connection.readyState === 0) {
    server = await MongoMemoryServer.create({
      binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY || '/usr/bin/mongod' },
    });
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
