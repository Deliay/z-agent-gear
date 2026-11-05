import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useApolloClient } from '@apollo/client/react';
import { toast } from 'sonner';
import {
  GET_SESSION,
  GET_SESSIONS,
  GET_CONTROLLERS,
  GET_SESSION_MESSAGES,
} from '../../graphql/queries';
import {
  CLOSE_SESSION,
  DELETE_SESSION,
  DELETE_HISTORY_SESSION,
  SEND_SESSION_MESSAGE,
  CANCEL_GENERATION,
  RESUME_SESSION,
  SET_SESSION_MODE,
  SET_SESSION_MODEL,
  SET_SESSION_CONFIG_OPTION,
  ARCHIVE_SESSION,
} from '../../graphql/mutations';
import { HOME_OVERVIEW } from '../../graphql/home';
import type {
  GetSessionQuery,
  GetSessionMessagesQuery,
  GetControllersQuery,
  ResumeSessionMutation,
  SetSessionConfigOptionMutation,
  DeleteHistorySessionMutation,
  AgentModeData,
  AgentModelInfoData,
  SessionConfigOptionData,
  SessionReadOnlyReason,
} from '../../graphql/types';
import { getApiBase } from '../../lib/api-base';
import { logger } from '../../lib/logger';
import SessionHeader from './SessionHeader';
import MessageList from './MessageList';
import InputBox from './InputBox';
import ResumeConfirmDialog from './ResumeConfirmDialog';
import { PendingElicitationBanner } from './PendingElicitationBanner';
import { useCommandState } from '../../hooks/useCommandState';
import { useAgentCapabilities } from '../../hooks/useAgentCapabilities';
import { threadToMarkdown, downloadThreadMarkdown } from '../../lib/export-thread';
import { collectFullHistory } from '../../lib/session-messages';
import { PreviewPane } from './preview/PreviewPane';
import { destroyPreviewStore, getPreviewStore } from '../../stores/preview';
import { getPromptComposer, destroyPromptComposer } from '../../stores/prompt-composer';
import { getSplitMode, setSplitMode, type SplitMode } from '../../lib/split-prefs';
import { useLiveFileTracking } from '../../hooks/useLiveFileTracking';
import { annotationsToPartText } from '../../lib/preview/annotations-to-part';
import { mergeText, type PromptPart } from '../../lib/preview/prompt-parts';
import type { AnnotationBatch } from '../../lib/preview/types';

interface AcpMessage {
  id: string;
  sessionId: string;
  direction: string;
  type: string;
  content: string | Record<string, unknown>;
  metadata: string | null;
  createdAt: string;
}

const RESUME_TIMEOUT_MS = 30000;

/**
 * 断连恢复后自动发送的工作流继续提示词（对齐 orchestrator FALLBACK_PROMPT 语义）：
 * 显式要求 AI 调用工作流 MCP 工具恢复/推进节点，而不是只输出文本。
 */
const WORKFLOW_CONTINUE_PROMPT =
  '你身处一个自动化工作流系统，当前会话绑定到一个工作流节点。系统检测到会话此前断连，现已恢复。' +
  '你必须使用提供的工作流 MCP 工具对当前节点执行操作：先用 getNodeInfo 确认当前节点状态；' +
  '若节点为 FAILED 或 RETRY_FAILED，先调用 resumeFailedNode 将节点恢复为运行状态；然后继续你之前的工作，' +
  '完成时调用 completeCurrentNode（产物通过黑板工具写入），需要上游返工时调用 rejectCurrentNode 并给出明确原因，' +
  '确实无法继续时调用 failCurrentNode 说明原因。不要只输出文本而不调用工具。';

const errorMessages: Record<string, string> = {
  CONTROLLER_OFFLINE: 'Controller is offline. Please check your controller connection.',
  ACP_SERVER_UNAVAILABLE: 'ACP server is not available on the controller.',
  ACP_SESSION_EXPIRED: 'The remote session has expired. Please start a new session.',
  WORKSPACE_PATH_INVALID: 'The workspace path no longer exists on your controller.',
  RESUME_TIMEOUT: 'Resume timed out. Please try again or start a new session.',
};

function getErrorMessage(error?: string): string {
  return error ? (errorMessages[error] || `Failed to resume session: ${error}`) : 'Failed to resume session. Please try again.';
}

/** 只读提示文案：三场景统一「会话记录仅供只读回看」语义（服务端 readOnlyReason 为唯一判定来源） */
const READ_ONLY_NOTICES: Record<SessionReadOnlyReason, string> = {
  WORKSPACE_MISSING: '工作区已不存在，会话记录仅供只读回看。',
  CONTROLLER_MISSING: '控制器已不存在，会话记录仅供只读回看。',
  CLOUD_HOST_DESTROYED: '云电脑已销毁，会话记录仅供只读回看。',
};

interface SessionViewProps {
  sessionId: string;
  /** 会话删除/归档后的返回列表回调（路由页用于跳转回 /sessions） */
  onDeleted?: () => void;
}

export default function SessionView({ sessionId: id, onDeleted }: SessionViewProps) {
  const [messages, setMessages] = useState<AcpMessage[]>([]);
  const [status, setStatus] = useState<string>('connecting');
  const [sending, setSending] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeConfirmOpen, setResumeConfirmOpen] = useState(false);
  // 断连「继续」确认后：会话 ready（SSE idling）时自动发送工作流继续提示词
  const autoPromptAfterResumeRef = useRef(false);
  const [closing, setClosing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [modes, setModes] = useState<AgentModeData[]>([]);
  const [sseLoading, setSseLoading] = useState(false);
  const [sseError, setSseError] = useState(false);
  const [protocolMismatch, setProtocolMismatch] = useState<{ expectedVersion: number; agentVersion: number } | null>(null);
  const [initialConfigError, setInitialConfigError] = useState<{ modeId?: string; modelId?: string; error: string; at?: string } | null>(null);
  const lastInitialConfigToastRef = useRef<string | null>(null);
  const [currentModeId, setCurrentModeId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const initializedRef = useRef(false);
  const lastMessageIsSettingUpdateRef = useRef(false);

  const [availableModels, setAvailableModels] = useState<AgentModelInfoData[]>([]);
  const [currentModelId, setCurrentModelId] = useState<string | null>(null);
  const [configOptions, setConfigOptions] = useState<SessionConfigOptionData[]>([]);
  const { commands: availableCommands, updateCommands } = useCommandState();
  const client = useApolloClient();

  // ---- 分屏 / 预览区（#461，Phase 6） ----
  // Review 深链参数经 window.location 读取（router 无关，消费后 replaceState 清参）
  const [reviewDeepLink] = useState(() => new URLSearchParams(window.location.search).get('review'));
  const [splitMode, setSplitModeState] = useState<SplitMode>(() => getSplitMode(id));
  const [live, setLive] = useState(false);
  const [wideEnoughForHorizontal, setWideEnoughForHorizontal] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 1024px)').matches,
  );
  const previewStoreRef = useRef(getPreviewStore(id));

  // 批注回传 → 提示词片段区（来源徽标 origin）
  const handleAnnotation = useCallback((batch: AnnotationBatch) => {
    if (batch.comments.length === 0 && !batch.summary) return;
    getPromptComposer(id).appendPart({
      id: `ann-${Date.now()}`,
      type: 'text',
      text: annotationsToPartText(batch),
      origin: batch,
    });
    toast.success('批注已回传到输入区');
  }, [id]);

  // 深链临时分屏标记（不写偏好）：关闭最后一个 Review 标签后回退 chat
  const [tempSplit, setTempSplit] = useState(false);
  const [hasReviewTab, setHasReviewTab] = useState(false);
  useEffect(() => {
    const store = getPreviewStore(id);
    setHasReviewTab(store.getSnapshot().tabs.some((tab) => tab.kind === 'review'));
    return store.subscribe(() => {
      setHasReviewTab(store.getSnapshot().tabs.some((tab) => tab.kind === 'review'));
    });
  }, [id]);

  useEffect(() => {
    if (tempSplit && !hasReviewTab) {
      setTempSplit(false);
      setSplitModeState('chat');
    }
  }, [tempSplit, hasReviewTab]);

  // 宽度门控：不足 1024px 隐藏「左右分栏」入口（偏好不改写）
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = (): void => setWideEnoughForHorizontal(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Review 深链（裁决 13）：chat 时按宽度临时分屏（不写偏好），消费后清参防重复打开
  useEffect(() => {
    const reviewId = reviewDeepLink;
    if (!reviewId) return;
    getPreviewStore(id).openReview(reviewId);
    if (getSplitMode(id) === 'chat') {
      setSplitModeState(wideEnoughForHorizontal ? 'horizontal' : 'vertical');
      setTempSplit(true);
    }
    // 消费后清参（replaceState 防重复打开）
    const url = new URL(window.location.href);
    url.searchParams.delete('review');
    window.history.replaceState(window.history.state, '', url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reviewDeepLink]);

  const handleSplitModeChange = useCallback((mode: SplitMode) => {
    setTempSplit(false);
    setSplitModeState(mode);
    setSplitMode(id, mode);
    if (mode === 'chat') setLive(false);
  }, [id]);

  // 偏好 horizontal 但宽度不足：渲染 vertical 且不改写偏好（拉宽后自动恢复）
  const effectiveSplitMode: SplitMode =
    splitMode === 'horizontal' && !wideEnoughForHorizontal ? 'vertical' : splitMode;

  // 实况跟随（复用 mergeToolCallMessages 合并口径）
  useLiveFileTracking({ sessionId: id, messages, live: live && splitMode !== 'chat', store: previewStoreRef.current });

  // 卸载清理（裁决 1）：预览 / 片段 store 按会话销毁
  useEffect(() => {
    return () => {
      destroyPreviewStore(id);
      destroyPromptComposer(id);
    };
  }, [id]);

  const isWorking = status === 'running';

  const { data: sessionData, loading: sessionLoading, error: sessionError } = useQuery<GetSessionQuery>(GET_SESSION, {
    variables: { id },
  });

  const { data: controllersData } = useQuery<GetControllersQuery>(GET_CONTROLLERS, {
    // 断连场景：controller 重连后「继续」按钮依赖 controllerOnline 解锁，轮询保持新鲜
    pollInterval: 10000,
  });

  // 会话能力门控：只对「有快照 + 明确 unsupported」的入口生效（旧会话/partial 放行）
  const capabilities = useAgentCapabilities(sessionData?.session ?? null);

  /** SSE 状态事件里的 availableModels 是 controller 原文（无来源字段）；合并时保留 GraphQL 推断结果 */
  const mergeModelSources = useCallback(
    (incoming: AgentModelInfoData[]): void => {
      setAvailableModels((prev) => {
        const byId = new Map(prev.map((model) => [model.id, model]));
        return incoming.map((model) => {
          const known = byId.get(model.id);
          if (!known) return model;
          return {
            ...model,
            source: model.source ?? known.source,
            sourceProvider: model.sourceProvider ?? known.sourceProvider,
            group: model.group ?? known.group,
            basis: model.basis ?? known.basis,
          };
        });
      });
    },
    [],
  );

  const [closeSession] = useMutation(CLOSE_SESSION);
  const [deleteSession] = useMutation(DELETE_SESSION);
  const [deleteHistorySession] = useMutation<DeleteHistorySessionMutation>(DELETE_HISTORY_SESSION);
  const [sendMessage] = useMutation(SEND_SESSION_MESSAGE);
  const [cancelGeneration] = useMutation(CANCEL_GENERATION);
  const [resumeSession] = useMutation<ResumeSessionMutation>(RESUME_SESSION);
  const [setSessionMode] = useMutation(SET_SESSION_MODE);
  const [setSessionModel] = useMutation(SET_SESSION_MODEL);
  const [setSessionConfigOption] = useMutation<SetSessionConfigOptionMutation>(SET_SESSION_CONFIG_OPTION);
  const [archiveSession] = useMutation(ARCHIVE_SESSION);

  const handleSendMessage = useCallback(async (parts: PromptPart[]) => {
    if (!id || parts.length === 0) return;
    try {
      lastMessageIsSettingUpdateRef.current = false;
      setSending(true);
      // 裁决 6：content=合并文本（非空文本 \n\n 连接，兼容旧渲染与标题提取），parts 透传契约参数
      const content = mergeText(parts);
      await sendMessage({
        variables: {
          sessionId: id,
          content,
          type: 'text',
          parts: parts.map(({ id: _partId, origin: _origin, ...part }) => part),
        },
      });
    } catch (err) {
      logger.error({ err }, 'Failed to send message');
      setSending(false);
    }
  }, [id, sendMessage]);

  useEffect(() => {
    if (sessionData?.session && !initializedRef.current) {
      initializedRef.current = true;
      setStatus(sessionData.session.status);
      if (sessionData.session.modes) setModes(sessionData.session.modes as AgentModeData[]);
      if (sessionData.session.currentModeId) setCurrentModeId(sessionData.session.currentModeId);
      if (sessionData.session.availableModels) setAvailableModels(sessionData.session.availableModels as AgentModelInfoData[]);
      if (sessionData.session.currentModelId) setCurrentModelId(sessionData.session.currentModelId);
      if (sessionData.session.configOptions) setConfigOptions(sessionData.session.configOptions as SessionConfigOptionData[]);
    }
  }, [sessionData, id]);

  useEffect(() => {
    if (!id) return;

    const apiBase = getApiBase();
    const token = localStorage.getItem('auth_token') || '';
    setSseLoading(true);
    setSseError(false);

    const eventSource = new EventSource(`${apiBase}/api/session/${id}/stream?token=${encodeURIComponent(token)}`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'history') {
        setMessages(data.data);
        setHasMore(data.data.length >= 25);
        setSseLoading(false);
      } else if (data.type === 'message') {
        setSseLoading(false);
        setMessages((prev) => [...prev, data.data]);
        if (data.data.direction === 'output') {
          setSending(false);
        }
        try {
          const content = JSON.parse(data.data.content);
          if (content.sessionUpdate === 'config_option_update' || content.sessionUpdate === 'current_mode_update') {
            lastMessageIsSettingUpdateRef.current = true;
            if (content.configOptions != null) {
              const configOptions = content.configOptions;
              setConfigOptions(configOptions);
              for (const opt of configOptions) {
                const value = opt.value ?? opt.currentValue;
                if (opt.id === 'mode' && value) {
                  setCurrentModeId(value);
                } else if (opt.id === 'model' && value) {
                  setCurrentModelId(value);
                }
              }
            }
          } else if (content.sessionUpdate === 'available_commands_update') {
            lastMessageIsSettingUpdateRef.current = true;
            const commands = content.availableCommands ?? [];
            updateCommands(commands.map((cmd: { name: string; description?: string }) => ({
              name: cmd.name,
              description: cmd.description,
            })));
          } else {
            lastMessageIsSettingUpdateRef.current = false;
          }
        } catch { /* ignore parse errors */ }
      } else if (data.type === 'status') {
        setStatus(data.data.status);
        if (data.data.status === 'ended' && data.data.error) {
          setResuming(false);
          toast.error(getErrorMessage(data.data.error));
        }
        if (data.data.status === 'idling') {
          setResuming(false);
          // 断连恢复 ready：自动发送工作流继续提示词，引导 AI 调 MCP 工具推进节点
          if (autoPromptAfterResumeRef.current) {
            autoPromptAfterResumeRef.current = false;
            handleSendMessage([{ id: 'workflow-continue', type: 'text', text: WORKFLOW_CONTINUE_PROMPT }]);
          }
        }
        if (data.data.modes) setModes(data.data.modes);
        if (data.data.currentModeId) setCurrentModeId(data.data.currentModeId);
        if (data.data.availableModels) mergeModelSources(data.data.availableModels);
        if (data.data.currentModelId) setCurrentModelId(data.data.currentModelId);
        if (data.data.configOptions != null) setConfigOptions(data.data.configOptions);
        if (data.data.initialConfigError) setInitialConfigError(data.data.initialConfigError);
      } else if (data.type === 'config:changed') {
        if (data.data.configOptions != null) setConfigOptions(data.data.configOptions);
      } else if (data.type === 'mode:changed') {
        if (data.data.modeId) setCurrentModeId(data.data.modeId);
      } else if (data.type === 'model:changed') {
        if (data.data.modelId) setCurrentModelId(data.data.modelId);
      } else if (data.type === 'protocol-version-mismatch') {
        setProtocolMismatch({
          expectedVersion: data.data.expectedVersion,
          agentVersion: data.data.agentVersion,
        });
      }
    };

    eventSource.onerror = () => {
      logger.error('SSE connection error');
      setSseLoading(false);
      setSseError(true);
    };

    return () => {
      eventSource.close();
    };
  }, [id, updateCommands, handleSendMessage, mergeModelSources]);

  // 初始模式/模型应用失败（acp:initial-config:result 经 session:status 透传）：
  // 提示用户实际生效值，避免误以为所选模式/模型已生效。同一错误签名只提示一次。
  useEffect(() => {
    if (!initialConfigError) return;
    const signature = `${initialConfigError.modeId ?? ''}|${initialConfigError.modelId ?? ''}|${initialConfigError.error}|${initialConfigError.at ?? ''}`;
    if (lastInitialConfigToastRef.current === signature) return;
    lastInitialConfigToastRef.current = signature;
    const actualParts: string[] = [];
    if (initialConfigError.modeId) {
      const modeName = modes.find((mode) => mode.id === currentModeId)?.name ?? currentModeId;
      actualParts.push(`当前生效模式：${modeName ?? '默认'}`);
    }
    if (initialConfigError.modelId) {
      const modelName = availableModels.find((model) => model.id === currentModelId)?.name ?? currentModelId;
      actualParts.push(`当前生效模型：${modelName ?? '默认'}`);
    }
    toast.error(`模式/模型设置未生效：${initialConfigError.error}`, {
      description: actualParts.length ? actualParts.join('，') : undefined,
    });
  }, [initialConfigError, modes, currentModeId, availableModels, currentModelId]);

  // Resume timeout protection
  useEffect(() => {
    if (!resuming) return;
    const timeout = setTimeout(() => {
      autoPromptAfterResumeRef.current = false;
      setResuming(false);
      setStatus('ended');
      toast.error(getErrorMessage('RESUME_TIMEOUT'));
    }, RESUME_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [resuming]);

  const handleCancelGeneration = async () => {
    if (!id) return;
    try {
      await cancelGeneration({ variables: { sessionId: id } });
    } catch (error) {
      logger.error({ err: error }, 'Failed to cancel generation');
    }
  };

  const handleCloseSession = async () => {
    if (!id) return;
    setClosing(true);
    try {
      await closeSession({ variables: { id } });
      setStatus('ended');
    } catch (error) {
      logger.error({ err: error }, 'Failed to close session');
    } finally {
      setClosing(false);
    }
  };

  const handleDeleteSession = async () => {
    if (!id) return;
    setDeleting(true);
    try {
      const isHistorySession = Boolean(sessionData?.session?.externalSessionId);
      if (isHistorySession) {
        const { data } = await deleteHistorySession({
          variables: { sessionId: id, syncAgent: true },
          refetchQueries: [{ query: GET_SESSIONS }],
        });
        if (data?.deleteHistorySession?.syncedToAgent === false && data.deleteHistorySession.error) {
          toast.warning(data.deleteHistorySession.error);
        }
      } else {
        await deleteSession({
          variables: { id },
          refetchQueries: [{ query: GET_SESSIONS }],
        });
      }
      onDeleted?.();
    } catch (error) {
      logger.error({ err: error }, 'Failed to delete session');
    } finally {
      setDeleting(false);
    }
  };

  const isWorkflowNodeSession = Boolean(sessionData?.session?.workflowInstanceId);

  /**
   * 归档/取消归档：
   * - 归档成功 toast 并返回会话列表（复用 onDeleted 路由回调 = navigate('/sessions')，对齐工作流实例归档）；
   * - 取消归档就地生效（refetch GET_SESSION 刷新徽标与入口）。
   * 工作流节点会话不渲染入口（服务端同样拒绝 ARCHIVE_WORKFLOW_SESSION_UNSUPPORTED）。
   */
  const handleArchiveToggle = async () => {
    const session = sessionData?.session;
    if (!session) return;
    const nextArchived = !session.archived;
    setArchiving(true);
    try {
      await archiveSession({
        variables: { id, archived: nextArchived },
        refetchQueries: [{ query: GET_SESSION }, { query: HOME_OVERVIEW }],
      });
      if (nextArchived) {
        toast.success('会话已归档');
        onDeleted?.();
      } else {
        toast.success('已取消归档');
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to archive session');
      toast.error(error instanceof Error ? error.message : '操作失败，请重试');
    } finally {
      setArchiving(false);
    }
  };

  /** 「继续」入口：断连会话先弹确认框，已结束会话直接 resume */
  const handleContinueClick = () => {
    if (status === 'disconnected') {
      setResumeConfirmOpen(true);
    } else {
      handleResumeSession();
    }
  };

  /** 确认让 AI 继续：工作流节点会话标记 ready 后自动发送继续提示词 */
  const handleConfirmResume = () => {
    setResumeConfirmOpen(false);
    autoPromptAfterResumeRef.current = isWorkflowNodeSession;
    handleResumeSession();
  };

  const handleResumeSession = async () => {
    if (!id) return;
    setResuming(true);
    setStatus('connecting');
    try {
      const { data } = await resumeSession({ variables: { id } });
      if (data?.resumeSession?.success === false) {
        setStatus('ended');
        setResuming(false);
        toast.error(getErrorMessage(data.resumeSession.error || undefined));
      }
    } catch {
      setStatus('ended');
      setResuming(false);
      toast.error('网络错误，请检查连接。');
    }
  };

  const handleSetMode = async (modeId: string) => {
    if (!id) return;
    setCurrentModeId(modeId);
    await setSessionMode({ variables: { sessionId: id, modeId } });
  };

  const handleSetModel = async (modelId: string) => {
    if (!id) return;
    setCurrentModelId(modelId);
    await setSessionModel({ variables: { sessionId: id, modelId } });
  };

  const handleSetConfigOption = async (configId: string, value: string) => {
    if (!id) return;
    try {
      const { data } = await setSessionConfigOption({ variables: { sessionId: id, configId, value } });
      if (data?.setSessionConfigOption === false) {
        toast.error('设置配置项失败，请稍后重试');
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to set config option');
      toast.error('设置配置项失败，请稍后重试');
    }
  };

  const handleLoadMore = async () => {
    if (!id || !hasMore || loadingMore || messages.length === 0) return;

    setLoadingMore(true);
    try {
      const firstMessageId = messages[0]?.id;
      if (!firstMessageId) {
        setLoadingMore(false);
        return;
      }

      const { data } = await client.query<GetSessionMessagesQuery>({
        query: GET_SESSION_MESSAGES,
        variables: {
          sessionId: id,
          before: firstMessageId,
          limit: 25,
        },
        fetchPolicy: 'network-only',
      });

      if (data?.sessionMessages) {
        const olderMessages = data.sessionMessages;
        if (olderMessages.length < 25) {
          setHasMore(false);
        }

        setMessages(prev => {
          const existingIds = new Set(prev.map(msg => msg.id));
          const newMessages = olderMessages.filter((msg: AcpMessage) => !existingIds.has(msg.id));
          return [...newMessages, ...prev];
        });
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to load more messages');
      toast.error('加载历史消息失败，请重试');
    } finally {
      setLoadingMore(false);
    }
  };

  const sessionController = controllersData?.controllers.find(
    (c) => c.id === sessionData?.session?.controllerId,
  );
  const controllerOnline = sessionController?.status === 'online';
  // 只读判定收敛为服务端 readOnlyReason（D5：规则集中后端，前端零规则重复）：
  // 控制器缺失 / 项目工作区缺失 / 云电脑终态三场景统一由字段 resolver 实时计算。
  const readOnlyReason = sessionData?.session?.readOnlyReason ?? null;
  const readOnly = readOnlyReason != null;

  if (sessionLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
      </div>
    );
  }

  // R2-21：目标会话不存在/无权限/查询失败时给出明确出口，避免落入「空会话+输入框」死页面。
  if (sessionError || !sessionData?.session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3" role="alert" data-testid="session-load-error">
        <p className="text-sm text-destructive">会话不存在或无权访问</p>
        {sessionError?.message && (
          <p className="max-w-md text-xs text-muted-foreground">{sessionError.message}</p>
        )}
        <a href="/" className="rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent">
          返回首页
        </a>
      </div>
    );
  }

  const handleExportThread = async () => {
    try {
      // R-1：导出前按 before 游标拉全历史，避免只导出 SSE 首帧已加载的窗口
      const { messages: fullMessages } = await collectFullHistory<AcpMessage>({
        loaded: messages,
        hasMore,
        fetchPage: async (before, limit) => {
          const { data } = await client.query<GetSessionMessagesQuery>({
            query: GET_SESSION_MESSAGES,
            variables: { sessionId: id, before, limit },
            fetchPolicy: 'network-only',
          });
          return (data?.sessionMessages ?? []) as AcpMessage[];
        },
      });

      if (fullMessages !== messages) {
        setMessages((prev) => (fullMessages.length > prev.length ? fullMessages : prev));
        setHasMore(false);
      }

      const markdown = threadToMarkdown(
        fullMessages.map((message) => ({
          direction: message.direction,
          content: message.content,
          createdAt: message.createdAt,
        })),
      );
      const date = new Date().toISOString().slice(0, 10);
      downloadThreadMarkdown(`session-${id}-${date}.md`, markdown);
      toast.success(`已导出对话（共 ${fullMessages.length} 条消息）`);
    } catch (error) {
      logger.error({ err: error }, 'Failed to export thread');
      toast.error('导出失败：无法加载完整历史，请重试');
    }
  };

  return (
    <div
      className={`grid h-full min-w-0 ${
        effectiveSplitMode === 'chat'
          ? 'grid-cols-1'
          : effectiveSplitMode === 'horizontal'
            ? 'grid-cols-[4fr_6fr]'
            : 'grid-cols-1 grid-rows-[3fr_7fr]'
      }`}
      data-testid="session-split-root"
      data-split-mode={effectiveSplitMode}
    >
      <div className="flex min-w-0 flex-col">
      {protocolMismatch && (
        <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          ⚠️ Agent 协议版本不兼容：期望 v{protocolMismatch.expectedVersion}，Agent 返回 v{protocolMismatch.agentVersion}。部分功能可能无法正常工作。
        </div>
      )}
      <SessionHeader
        session={sessionData?.session ? {
          id: sessionData.session.id,
          userId: sessionData.session.userId,
          controllerId: sessionData.session.controllerId,
          controllerName: sessionData.session.controllerName,
          acpServerType: sessionData.session.acpServerType,
          status: sessionData.session.status,
          externalSessionId: sessionData.session.externalSessionId,
          cwd: sessionData.session.cwd,
          worktreePath: ('worktreePath' in sessionData.session ? (sessionData.session as { worktreePath?: string }).worktreePath : null) || null,
          createdAt: sessionData.session.createdAt,
          updatedAt: sessionData.session.updatedAt,
          endedAt: sessionData.session.endedAt,
          archived: sessionData.session.archived,
        } : null}
        status={status}
        onClose={handleCloseSession}
        onDelete={handleDeleteSession}
        onContinue={handleContinueClick}
        resuming={resuming}
        closing={closing}
        deleting={deleting}
        controllerOnline={controllerOnline}
        capabilities={capabilities}
        capabilitySession={sessionData?.session ?? null}
        readOnly={readOnly}
        onExport={handleExportThread}
        onArchiveToggle={isWorkflowNodeSession ? undefined : handleArchiveToggle}
        archiving={archiving}
        splitMode={splitMode}
        onSplitModeChange={handleSplitModeChange}
        live={live}
        onLiveChange={setLive}
        wideEnoughForHorizontal={wideEnoughForHorizontal}
      />
      <PendingElicitationBanner sessionId={id} />
      {readOnly && readOnlyReason && (
        <div
          className="border-b border-border bg-muted/50 px-4 py-2 text-sm text-muted-foreground"
          data-testid="session-readonly-notice"
          data-readonly-reason={readOnlyReason}
        >
          {readOnlyReason === 'CLOUD_HOST_DESTROYED' ? (
            <span data-testid="cloud-host-readonly-notice">{READ_ONLY_NOTICES[readOnlyReason]}</span>
          ) : (
            READ_ONLY_NOTICES[readOnlyReason]
          )}
        </div>
      )}
      <MessageList
        messages={messages}
        sseLoading={sseLoading}
        sseError={sseError}
        hasMore={hasMore}
        onLoadMore={handleLoadMore}
        loadingMore={loadingMore}
      />
      {!readOnly && (
        <InputBox
          sessionId={id}
          onSend={handleSendMessage}
          onStop={handleCancelGeneration}
          disabled={status !== 'idling' && status !== 'running'}
          sending={sending}
          isWorking={isWorking}
          modes={modes}
          currentModeId={currentModeId}
          onSetMode={handleSetMode}
          status={status}
          availableModels={availableModels}
          currentModelId={currentModelId}
          onSetModel={handleSetModel}
          availableCommands={availableCommands}
          configOptions={configOptions}
          onSetConfigOption={handleSetConfigOption}
          capabilities={capabilities}
        />
      )}
      <ResumeConfirmDialog
        open={resumeConfirmOpen}
        onOpenChange={setResumeConfirmOpen}
        onConfirm={handleConfirmResume}
        isWorkflowNode={isWorkflowNodeSession}
      />
      </div>
      {effectiveSplitMode !== 'chat' && (
        <div className="flex min-h-0 min-w-0 flex-col border-l border-border" data-testid="session-preview-column">
          <PreviewPane sessionId={id} onAnnotation={handleAnnotation} />
        </div>
      )}
    </div>
  );
}
