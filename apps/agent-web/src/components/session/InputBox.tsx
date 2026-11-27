import { useState, useEffect, useRef, useCallback } from 'react';
import type { AgentModelInfoData } from '../../graphql/types';
import type { SessionConfigOptionData } from '../../graphql/types';
import type { Command } from '../../hooks/useCommandState';
import { fuzzyMatch } from '../../lib/fuzzyMatch';
import type { AgentCapabilitiesController } from '../../hooks/useAgentCapabilities';
import ModeSwitcher from './ModeSwitcher';
import { ModelSwitcher } from './ModelSwitcher';
import ConfigOptionsPanel from './ConfigOptionsPanel';
import CommandSuggest from './CommandSuggest';
import { usePromptComposer, type ComposerPart } from '../../stores/prompt-composer';
import {
  buildSendParts,
  checkPartSizes,
  serializeDraft,
  deserializeDraft,
  stripDataPrefix,
  nextPartId,
  MAX_IMAGE_BYTES,
  type PromptPart,
} from '../../lib/preview/prompt-parts';
import { toast } from 'sonner';

interface AgentMode {
  id: string;
  name: string;
  description?: string | null;
}

interface InputBoxProps {
  /** 发送组装（裁决 6）：`[...parts, ...(trim(input) ? [textPart] : [])]` */
  onSend: (parts: PromptPart[]) => void;
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
  configOptions?: SessionConfigOptionData[];
  onSetConfigOption?: (configId: string, value: string) => Promise<void>;
  /** 会话能力门控（缺省 = 未知能力，全部放行） */
  capabilities?: AgentCapabilitiesController;
}

const STORAGE_PREFIX = 'session_input_';
const PARTS_STORAGE_PREFIX = 'session_input_parts_';

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

export default function InputBox({ onSend, onStop, disabled, sending, isWorking, modes = [], currentModeId, onSetMode, status = '', availableModels = [], currentModelId, onSetModel, sessionId, availableCommands = [], configOptions = [], onSetConfigOption, capabilities }: InputBoxProps) {
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- 提示词片段区（#461，裁决 6）：prompt-composer store 单一来源 ----
  const composer = usePromptComposer(sessionId ?? 'standalone');
  const composerParts = composer.parts;
  const imageBlocked = capabilities?.isBlocked('prompt.image') ?? false;

  // 片段草稿：>2MB 不持久化（裁决 6）；挂载时恢复
  useEffect(() => {
    if (!sessionId) return;
    try {
      const raw = localStorage.getItem(PARTS_STORAGE_PREFIX + sessionId);
      const restored = deserializeDraft(raw);
      if (restored.length > 0 && composerParts.length === 0) {
        for (const part of restored) composer.appendPart(part as ComposerPart);
      }
    } catch { /* 忽略损坏草稿 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const serialized = serializeDraft(composerParts);
    if (serialized === null) {
      localStorage.removeItem(PARTS_STORAGE_PREFIX + sessionId);
      return;
    }
    if (composerParts.length > 0) {
      localStorage.setItem(PARTS_STORAGE_PREFIX + sessionId, serialized);
    } else {
      localStorage.removeItem(PARTS_STORAGE_PREFIX + sessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerParts, sessionId]);

  /** 图片添加（粘贴 / 文件选择）：单图 ≤5MB、合计 ≤10MB（裁决 8） */
  const addImageFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files).filter((file) => file.type.startsWith('image/'));
    for (const file of list) {
      if (file.size > MAX_IMAGE_BYTES) {
        toast.error(`图片 ${file.name} 超过 5MB 上限`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const data = stripDataPrefix(String(reader.result ?? ''));
        const next = [...composerParts, { id: nextPartId('img'), type: 'image' as const, data, mimeType: file.type, name: file.name }];
        const sizeCheck = checkPartSizes(next as PromptPart[]);
        if (!sizeCheck.ok) {
          toast.error(sizeCheck.reason === 'image-too-large' ? `图片 ${file.name} 超过 5MB 上限` : '片段合计超过 10MB 上限');
          return;
        }
        composer.appendPart({ id: next[next.length - 1].id, type: 'image', data, mimeType: file.type, name: file.name });
      };
      reader.readAsDataURL(file);
    }
  }, [composer, composerParts]);

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
    // 发送组装（裁决 6）：[...parts, ...(trim(input) ? [textPart] : [])]；能力门控降级图片（裁决 14）
    const composed = composerParts.map((part): PromptPart => {
      if (part.type === 'image' && imageBlocked) {
        return { id: part.id, type: 'text', text: `[图片 ${part.name ?? ''}]`.trim() };
      }
      return part as PromptPart;
    });
    const sendParts = buildSendParts(composed, input);
    if (sendParts.length > 0 && !disabled && !sending) {
      onSend(sendParts);
      setInput('');
      setShowSuggest(false);
      composer.clear();
      if (sessionId) {
        localStorage.removeItem(STORAGE_PREFIX + sessionId);
        localStorage.removeItem(PARTS_STORAGE_PREFIX + sessionId);
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

    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
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
    <div ref={containerRef} className="relative px-4 pb-4 pt-2" data-testid="input-box">
      {/* 一体化浮岛（规范 §6-C）：模式/模型/配置/附件/片段全部收进输入卡片 */}
      <form
        onSubmit={handleSubmit}
        data-testid="input-island"
        className="mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-sm"
      >
        {onSetConfigOption && (
          <ConfigOptionsPanel
            configOptions={configOptions}
            status={status}
            onSetConfigOption={onSetConfigOption}
            booleanBlocked={capabilities?.isBlocked('config.boolean') ?? false}
          />
        )}
        {/* 提示词片段区（文本片段首行摘要 + 来源徽标；图片缩略 + 名称；逐行删除） */}
        {composerParts.length > 0 && (
          <div className="space-y-1" data-testid="prompt-parts">
            {composerParts.map((part) => (
              <div
                key={part.id}
                className="flex items-center gap-2 rounded-md bg-muted/60 px-2 py-1 text-xs"
                data-testid="prompt-part"
                data-part-type={part.type}
              >
                {part.type === 'image' ? (
                  <>
                    {part.data && (
                      <img
                        src={`data:${part.mimeType ?? 'image/png'};base64,${part.data}`}
                        alt={part.name ?? 'image'}
                        className="h-8 w-8 rounded-sm object-cover"
                        data-testid="prompt-part-image"
                      />
                    )}
                    <span className="min-w-0 truncate">{part.name ?? '图片'}</span>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate">
                      {(part.text ?? '').split('\n')[0].slice(0, 80)}
                    </span>
                    {part.origin && (
                      <span className="shrink-0 rounded-sm bg-muted px-1 text-xs text-muted-foreground" data-testid="prompt-part-origin">
                        批注
                      </span>
                    )}
                  </>
                )}
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground hover:text-destructive-text"
                  onClick={() => composer.removePart(part.id)}
                  data-testid="prompt-part-remove"
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="relative">
          <textarea
            ref={(el) => {
              textareaRef[1](el);
              if (el) autoGrow(el);
            }}
            value={input}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={(event) => {
              if (imageBlocked) return;
              const files = event.clipboardData?.files;
              if (files && files.length > 0) {
                event.preventDefault();
                addImageFiles(files);
              }
            }}
            disabled={disabled || sending}
            placeholder={
              disabled
                ? '会话未激活，暂不可发送'
                : sending
                  ? 'Agent 正在处理…'
                  : `输入消息，${IS_MAC ? '⌘' : 'Ctrl'} + Enter 发送`
            }
            className="w-full resize-none border-0 bg-transparent px-1 py-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:text-muted-foreground"
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
        {/* 底栏：模式 / 模型 / 附件 / 中文主按钮 */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2" data-testid="input-island-footer">
          {onSetMode && (
            <ModeSwitcher
              currentModeId={currentModeId}
              modes={modes}
              status={status}
              onSetMode={onSetMode}
              disabled={isWorking}
              blocked={capabilities?.isBlocked('config.mode') ?? false}
              blockedReason={capabilities?.detail('config.mode')}
            />
          )}
          {onSetModel && (
            <ModelSwitcher
              currentModelId={currentModelId}
              availableModels={availableModels}
              status={status}
              onSetModel={onSetModel}
              disabled={isWorking}
              blocked={capabilities?.isBlocked('config.model') ?? false}
              blockedReason={capabilities?.detail('config.model')}
            />
          )}
          <div className="ml-auto flex items-center gap-2">
            {!imageBlocked && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  data-testid="prompt-image-input"
                  onChange={(event) => {
                    if (event.target.files) addImageFiles(event.target.files);
                    event.target.value = '';
                  }}
                />
                <button
                  type="button"
                  className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                  title="添加图片"
                  aria-label="添加图片"
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="prompt-image-add"
                >
                  图片
                </button>
              </>
            )}
            {(sending || isWorking) ? (
              <button
                type="button"
                onClick={handleStop}
                data-testid="input-stop"
                className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
              >
                停止
              </button>
            ) : (
              <button
                type="submit"
                data-testid="input-send"
                disabled={disabled || (!input.trim() && composerParts.length === 0)}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
              >
                发送
                <span className="ml-1 text-xs opacity-80">{IS_MAC ? '⌘↵' : 'Ctrl+↵'}</span>
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
