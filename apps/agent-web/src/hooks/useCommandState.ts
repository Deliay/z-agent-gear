import { useState, useCallback } from 'react';

export interface Command {
  name: string;
  description?: string;
}

export function useCommandState() {
  const [commands, setCommands] = useState<Command[]>([]);

  const updateCommands = useCallback((newCommands: Command[]) => {
    setCommands(newCommands);
  }, []);

  return { commands, updateCommands };
}
