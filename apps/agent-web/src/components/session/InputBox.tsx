import { useState } from 'react';
import ModeSwitcher from './ModeSwitcher';

interface AgentMode {
  id: string;
  name: string;
  description?: string | null;
}

interface InputBoxProps {
  onSend: (content: string) => void;
  onStop?: () => void;
  disabled: boolean;
  sending?: boolean;
  modes?: AgentMode[];
  currentModeId?: string | null;
  onSetMode?: (modeId: string) => Promise<void>;
  status?: string;
}

export default function InputBox({ onSend, onStop, disabled, sending, modes = [], currentModeId, onSetMode, status = '' }: InputBoxProps) {
  const [input, setInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !disabled && !sending) {
      onSend(input.trim());
      setInput('');
    }
  };

  const handleStop = () => {
    onStop?.();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="border-t border-gray-200 bg-white p-4">
      <form onSubmit={handleSubmit} className="flex gap-2">
        {onSetMode && (
          <ModeSwitcher
            currentModeId={currentModeId}
            modes={modes}
            status={status}
            onSetMode={onSetMode}
          />
        )}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || sending}
          placeholder={
            disabled
              ? 'Session is not active...'
              : sending
                ? 'Agent is processing...'
                : 'Type your message...'
          }
          className="flex-1 resize-none rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
          rows={1}
        />
        {sending ? (
          <button
            type="button"
            onClick={handleStop}
            className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || !input.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
