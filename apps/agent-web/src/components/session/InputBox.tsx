import { useState, useEffect } from 'react';
import type { AgentModelInfoData } from '../../graphql/types';
import ModeSwitcher from './ModeSwitcher';
import { ModelSwitcher } from './ModelSwitcher';

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
  availableModels?: AgentModelInfoData[];
  currentModelId?: string | null;
  onSetModel?: (modelId: string) => Promise<void>;
  sessionId?: string;
}

const STORAGE_PREFIX = 'session_input_';

export default function InputBox({ onSend, onStop, disabled, sending, modes = [], currentModeId, onSetMode, status = '', availableModels = [], currentModelId, onSetModel, sessionId }: InputBoxProps) {
  const [input, setInput] = useState('');

  const textareaRef = useState<HTMLTextAreaElement | null>(null);

  const getTextarea = () => textareaRef[0];

  useEffect(() => {
    if (!sessionId) return;
    const saved = localStorage.getItem(STORAGE_PREFIX + sessionId);
    if (saved) {
      setInput(saved);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    if (input) {
      localStorage.setItem(STORAGE_PREFIX + sessionId, input);
    } else {
      localStorage.removeItem(STORAGE_PREFIX + sessionId);
    }
  }, [input, sessionId]);

  const autoGrow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !disabled && !sending) {
      onSend(input.trim());
      setInput('');
      if (sessionId) {
        localStorage.removeItem(STORAGE_PREFIX + sessionId);
      }
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

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    autoGrow(e.target);
  };

  return (
    <div className="border-t border-gray-200 bg-white p-4">
      <div className="mb-2 flex items-center gap-2">
        {onSetMode && (
          <ModeSwitcher
            currentModeId={currentModeId}
            modes={modes}
            status={status}
            onSetMode={onSetMode}
          />
        )}
        {onSetModel && (
          <ModelSwitcher
            currentModelId={currentModelId}
            availableModels={availableModels}
            status={status}
            onSetModel={onSetModel}
          />
        )}
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <textarea
          ref={(el) => {
            textareaRef[1](el);
            if (el) autoGrow(el);
          }}
          value={input}
          onChange={handleChange}
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
          style={{ maxHeight: '5rem', overflowY: 'auto' }}
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
