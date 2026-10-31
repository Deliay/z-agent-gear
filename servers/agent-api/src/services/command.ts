import { publish } from '../middleware/publish.js';

const COMMAND_CHANNEL = 'controller:command';

export class CommandService {
  async sendShutdown(keyId: string): Promise<void> {
    await publish(COMMAND_CHANNEL, { type: 'shutdown', keyId });
  }
}

export const commandService = new CommandService();
