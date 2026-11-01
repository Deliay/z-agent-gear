import { logger } from '../observability/logger.js';
import { AcpMessage } from '../models/acp-message.js';

const log = logger.child({ component: 'migration/001-unify-content-format' });

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
      let parsed;
      try {
        parsed = JSON.parse(msg.content as string);
      } catch {
        const rawText = String(msg.content ?? '');
        parsed = {
          sessionUpdate: msg.direction === 'input' ? 'user_message_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: rawText },
        };
      }
      return {
        updateOne: {
          filter: { _id: msg._id },
          update: { $set: { content: parsed } },
        },
      };
    });

    await AcpMessage.bulkWrite(operations);
    processed += batch.length;
    log.debug({ processed }, 'processed messages');
  }
}
