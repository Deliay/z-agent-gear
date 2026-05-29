import { useState, useEffect, useRef, useCallback } from 'react';
import type { AgentModelInfoData } from '../../graphql/types';
import type { Command } from '../../hooks/useCommandState';
import { fuzzyMatch } from '../../lib/fuzzyMatch';
import ModeSwitcher from './ModeSwitcher';
import { ModelSwitcher } from './ModelSwitcher';
import CommandSuggest from './CommandSuggest';

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
  isWorking?: boolean;
  modes?: AgentMode[];
  currentModeId?: string | null;
  onSetMode?: (modeId: string) => Promise<void>;
  status?: string;
  availableModels?: AgentModelInfoData[];
  currentModelId?: string | null;
  onSetModel?: (modelId: string) => Promise<void>;
  sessionId?: string;
  availableCommands?: Command[];
}

const STORAGE_PREFIX = 'session_input_';

export default function InputBox({ onSend, onStop, disabled, sending, isWorking, modes = [], currentModeId, onSetMode, status = '', availableModels = [], currentModelId, onSetModel, sessionId, availableCommands = [] }: InputBoxProps) {
  const [input, setInput] = useState(() => {
    if (sessionId) {
      return localStorage.getItem(STORAGE_PREFIX + sessionId) || '';
    }
    return '';
  });
  const [showSuggest, setShowSuggest] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const textareaRef = useState<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filteredCommands = availableCommands.filter((cmd) => fuzzyMatch(commandQuery, cmd.name));

  const getCommandTrigger = useCallback((value: string) => {
    if (!value.startsWith('/')) return null;
    
    const spaceIndex = value.indexOf(' ');
    const newlineIndex = value.indexOf('\n');
    const endIndex = Math.min(
      spaceIndex === -1 ? Infinity : spaceIndex,
      newlineIndex === -1 ? Infinity : newlineIndex
    );
    
    if (endIndex === 1) return null;
    
    return value.slice(1, endIndex === Infinity ? undefined : endIndex);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    if (input) {
      localStorage.setItem(STORAGE_PREFIX + sessionId, input);
    } else {
      localStorage.removeItem(STORAGE_PREFIX + sessionId);
    }
  }, [input, sessionId]);

  const updateCommandSuggest = useCallback((value: string) => {
    const query = getCommandTrigger(value);
    if (query !== null && availableCommands.length > 0) {
      setCommandQuery(query);
      setShowSuggest(true);
      setSelectedIndex(0);
    } else {
      setShowSuggest(false);
      setCommandQuery('');
    }
  }, [getCommandTrigger, availableCommands]);

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
      setShowSuggest(false);
      if (sessionId) {
        localStorage.removeItem(STORAGE_PREFIX + sessionId);
      }
    }
  };

  const handleStop = () => {
    onStop?.();
  };

  const handleCommandSelect = (command: Command) => {
    setInput(`/${command.name} `);
    setShowSuggest(false);
    setCommandQuery('');
    textareaRef[0]?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSuggest && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        handleCommandSelect(filteredCommands[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSuggest(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    autoGrow(e.target);
    updateCommandSuggest(value);
  };

  return (
    <div ref={containerRef} className="relative border-t border-border bg-background p-4">
      <div className="mb-2 flex items-center gap-2">
        {onSetMode && (
          <ModeSwitcher
            currentModeId={currentModeId}
            modes={modes}
            status={status}
            onSetMode={onSetMode}
            disabled={isWorking}
          />
        )}
        {onSetModel && (
          <ModelSwitcher
            currentModelId={currentModelId}
            availableModels={availableModels}
            status={status}
            onSetModel={onSetModel}
            disabled={isWorking}
          />
        )}
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="relative flex-1">
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
            className="w-full resize-none rounded-md border border-input px-3 py-2 text-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:bg-muted disabled:text-muted-foreground"
            style={{ maxHeight: '10rem', overflowY: 'auto' }}
            rows={1}
          />
          {showSuggest && filteredCommands.length > 0 && (
            <CommandSuggest
              commands={availableCommands}
              query={commandQuery}
              position={{ top: 8, left: 0 }}
              onSelect={handleCommandSelect}
              onClose={() => setShowSuggest(false)}
              selectedIndex={selectedIndex}
              onSelectedIndexChange={setSelectedIndex}
            />
          )}
        </div>
        {(sending || isWorking) ? (
          <button
            type="button"
            onClick={handleStop}
            className="rounded-md bg-destructive px-4 py-2 text-sm text-destructive-foreground hover:bg-destructive/90"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || !input.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
