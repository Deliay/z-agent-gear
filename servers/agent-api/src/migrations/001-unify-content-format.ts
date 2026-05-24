import { AcpMessage } from '../models/acp-message.js';

export const name = '001-unify-content-format';

export async function run(): Promise<void> {
  const batchSize = 100;
  let processed = 0;

  while (true) {
    const batch = await AcpMessage.find({
      type: 'text',
      content: { $type: 'string' },
    })
      .limit(batchSize)
      .lean();

    if (batch.length === 0) break;

    const operations = batch.map((msg) => {
      const parsed = JSON.parse(msg.content as string);
      return {
        updateOne: {
          filter: { _id: msg._id },
          update: { $set: { content: parsed } },
        },
      };
    });

    await AcpMessage.bulkWrite(operations);
    processed += batch.length;
    console.log(`[Migration 001] Processed ${processed} messages`);
  }
}
