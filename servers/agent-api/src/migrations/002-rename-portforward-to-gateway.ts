import mongoose from 'mongoose';

const OLD_COLLECTION = 'portforwards';
const NEW_COLLECTION = 'gateways';

export const name = '002-rename-portforward-to-gateway';

export async function run(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) {
    console.log('[Migration 002] No database connection, skipping');
    return;
  }

  const collections = await db.listCollections({ name: OLD_COLLECTION }).toArray();
  if (collections.length === 0) {
    console.log('[Migration 002] No portforwards collection found, skipping');
    return;
  }

  const newCollections = await db.listCollections({ name: NEW_COLLECTION }).toArray();
  if (newCollections.length > 0) {
    console.log('[Migration 002] gateways collection already exists, dropping old collection');
    await db.dropCollection(OLD_COLLECTION);
    return;
  }

  await db.renameCollection(OLD_COLLECTION, NEW_COLLECTION);

  const gw = db.collection(NEW_COLLECTION);

  const duplicatePorts = await gw.aggregate([
    { $group: { _id: { controllerId: '$controllerId', port: '$port' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  if (duplicatePorts.length > 0) {
    console.log(`[Migration 002] Found ${duplicatePorts.length} duplicate port groups, generating unique names`);
  }

  const docs = await gw.find({}).toArray();
  const nameCounter: Map<string, number> = new Map();

  for (const doc of docs) {
    const key = `${doc.controllerId}_${doc.port}`;
    const count = nameCounter.get(key) || 0;
    nameCounter.set(key, count + 1);

    let name = `port_${doc.port}`;
    if (count > 0) {
      name = `port_${doc.port}_${count}`;
    }

    await gw.updateOne(
      { _id: doc._id },
      { $set: { name } },
    );
  }

  await gw.createIndex({ controllerId: 1, name: 1 }, { unique: true });
  await gw.dropIndex('controllerId_1_port_1');

  console.log(`[Migration 002] Renamed ${docs.length} records from portforwards to gateways`);
}
