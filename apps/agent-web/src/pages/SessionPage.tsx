import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@apollo/client/react';
import {
  GET_SESSION,
  GET_SESSIONS,
  GET_CONTROLLERS,
} from '../graphql/queries';
import {
  CREATE_SESSION,
  CLOSE_SESSION,
  DELETE_SESSION,
  SEND_SESSION_MESSAGE,
  CANCEL_GENERATION,
  RESUME_SESSION,
  SET_SESSION_MODE,
  SET_SESSION_MODEL,
} from '../graphql/mutations';
import type {
  GetSessionQuery,
  GetControllersQuery,
  CreateSessionMutation,
  ResumeSessionMutation,
  AgentModeData,
  AgentModelInfoData,
} from '../graphql/types';
import SessionHeader from '../components/session/SessionHeader';
import MessageList from '../components/session/MessageList';
import InputBox from '../components/session/InputBox';
import NewSessionDialog from '../components/session/NewSessionDialog';

interface AcpMessage {
  id: string;
  sessionId: string;
  direction: string;
  type: string;
  content: string;
  metadata: string | null;
  createdAt: string;
}

const RESUME_TIMEOUT_MS = 30000;

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

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [showNewSessionDialog, setShowNewSessionDialog] = useState(false);
  const [messages, setMessages] = useState<AcpMessage[]>([]);
  const [status, setStatus] = useState<string>('connecting');
  const [sending, setSending] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [modes, setModes] = useState<AgentModeData[]>([]);
  const [currentModeId, setCurrentModeId] = useState<string | null>(null);

  const [availableModels, setAvailableModels] = useState<AgentModelInfoData[]>([]);
  const [currentModelId, setCurrentModelId] = useState<string | null>(null);
  const [_currentModel, setCurrentModel] = useState<AgentModelInfoData | null>(null);

  const { data: sessionData, loading: sessionLoading } = useQuery<GetSessionQuery>(GET_SESSION, {
    variables: { id },
    skip: !id,
  });

  const { data: controllersData } = useQuery<GetControllersQuery>(GET_CONTROLLERS);

  const [createSession] = useMutation<CreateSessionMutation>(CREATE_SESSION);
  const [closeSession] = useMutation(CLOSE_SESSION);
  const [deleteSession] = useMutation(DELETE_SESSION);
  const [sendMessage] = useMutation(SEND_SESSION_MESSAGE);
  const [cancelGeneration] = useMutation(CANCEL_GENERATION);
  const [resumeSession] = useMutation<ResumeSessionMutation>(RESUME_SESSION);
  const [setSessionMode] = useMutation(SET_SESSION_MODE);
  const [setSessionModel] = useMutation(SET_SESSION_MODEL);

  useEffect(() => {
    if (sessionData?.session) {
      setStatus(sessionData.session.status);
      if (sessionData.session.modes) setModes(sessionData.session.modes as AgentModeData[]);
      if (sessionData.session.currentModeId) setCurrentModeId(sessionData.session.currentModeId);
      if (sessionData.session.currentModel) setCurrentModel(sessionData.session.currentModel as AgentModelInfoData);
      if (sessionData.session.availableModels) setAvailableModels(sessionData.session.availableModels as AgentModelInfoData[]);
      if (sessionData.session.currentModelId) setCurrentModelId(sessionData.session.currentModelId);
    }
  }, [sessionData]);

  useEffect(() => {
    if (!id) return;

    const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:4000';
    const token = localStorage.getItem('auth_token') || '';
    const eventSource = new EventSource(`${apiBase}/api/session/${id}/stream?token=${encodeURIComponent(token)}`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'history') {
        setMessages(data.data);
      } else if (data.type === 'message') {
        setMessages((prev) => [...prev, data.data]);
        if (data.data.direction === 'output') {
          setSending(false);
        }
        // Parse config_option_update and current_mode_update from message content
        try {
          const content = JSON.parse(data.data.content);
          if (content.sessionUpdate === 'config_option_update') {
            const configOptions = content.configOptions ?? [];
            for (const opt of configOptions) {
              const value = opt.value ?? opt.currentValue;
              if (opt.id === 'mode' && value) {
                setCurrentModeId(value);
              } else if (opt.id === 'model' && value) {
                setCurrentModelId(value);
              }
            }
          } else if (content.sessionUpdate === 'current_mode_update') {
            if (content.modeId) setCurrentModeId(content.modeId);
          }
        } catch { /* ignore parse errors */ }
      } else if (data.type === 'status') {
        setStatus(data.data.status);
        if (data.data.status === 'ended' && data.data.error) {
          setResuming(false);
          setErrorToast(getErrorMessage(data.data.error));
        }
        if (data.data.status === 'idling') {
          setResuming(false);
        }
        if (data.data.modes) setModes(data.data.modes);
        if (data.data.currentModeId) setCurrentModeId(data.data.currentModeId);
        if (data.data.currentModel) setCurrentModel(data.data.currentModel);
        if (data.data.availableModels) setAvailableModels(data.data.availableModels);
        if (data.data.currentModelId) setCurrentModelId(data.data.currentModelId);
      } else if (data.type === 'mode:changed') {
        if (data.data.modeId) setCurrentModeId(data.data.modeId);
      } else if (data.type === 'model:changed') {
        if (data.data.modelId) setCurrentModelId(data.data.modelId);
      }
    };

    eventSource.onerror = () => {
      console.error('SSE connection error');
    };

    return () => {
      eventSource.close();
    };
  }, [id]);

  // Resume timeout protection
  useEffect(() => {
    if (!resuming) return;
    const timeout = setTimeout(() => {
      setResuming(false);
      setStatus('ended');
      setErrorToast(getErrorMessage('RESUME_TIMEOUT'));
    }, RESUME_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [resuming]);

  // Auto-dismiss error toast
  useEffect(() => {
    if (!errorToast) return;
    const timer = setTimeout(() => setErrorToast(null), 5000);
    return () => clearTimeout(timer);
  }, [errorToast]);

  const handleCreateSession = async (controllerId: string, acpServerType: string, workspaceId: string, enableWorktree?: boolean, worktreeBranchSuffix?: string) => {
    try {
      const { data } = await createSession({
        variables: {
          input: {
            controllerId,
            acpServerType,
            workspaceId,
            enableWorktree: enableWorktree || false,
            worktreeBranchSuffix: worktreeBranchSuffix || null,
          },
        },
        refetchQueries: [{ query: GET_SESSIONS }],
      });
      if (data?.createSession?.session?.id) {
        navigate(`/sessions/${data.createSession.session.id}`);
      }
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  };

  const handleCancelGeneration = async () => {
    if (!id) return;
    try {
      await cancelGeneration({ variables: { sessionId: id } });
    } catch (error) {
      console.error('Failed to cancel generation:', error);
    }
  };

  const handleCloseSession = async () => {
    if (!id) return;
    try {
      await closeSession({ variables: { id } });
      setStatus('ended');
    } catch (error) {
      console.error('Failed to close session:', error);
    }
  };

  const handleDeleteSession = async () => {
    if (!id) return;
    try {
      await deleteSession({
        variables: { id },
        refetchQueries: [{ query: GET_SESSIONS }],
      });
      navigate('/sessions');
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
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
        setErrorToast(getErrorMessage(data.resumeSession.error || undefined));
      }
    } catch (error) {
      setStatus('ended');
      setResuming(false);
      setErrorToast('Network error. Please check your connection.');
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

  const handleSendMessage = async (content: string) => {
    if (!id) return;
    try {
      setSending(true);
      await sendMessage({
        variables: {
          sessionId: id,
          content,
          type: 'text',
        },
      });
    } catch (error) {
      console.error('Failed to send message:', error);
      setSending(false);
    }
  };

  const sessionController = controllersData?.controllers.find(
    (c) => c.id === sessionData?.session?.controllerId,
  );
  const controllerOnline = sessionController?.status === 'online';

  if (sessionLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-blue-600" />
      </div>
    );
  }

  if (!id) {
    return (
      <div className="p-6">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold">Sessions</h1>
          <button
            type="button"
            onClick={() => setShowNewSessionDialog(true)}
            className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          >
            New Session
          </button>
        </div>
        <p className="text-gray-500">No sessions found.</p>

        {showNewSessionDialog && (
          <NewSessionDialog
            controllers={controllersData?.controllers || []}
            onClose={() => setShowNewSessionDialog(false)}
            onCreate={handleCreateSession}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {errorToast && (
        <div className="fixed right-4 top-4 z-50 max-w-sm rounded-md bg-red-50 px-4 py-3 text-sm text-red-800 shadow-lg">
          {errorToast}
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
          worktreePath: (sessionData.session as any).worktreePath || null,
          createdAt: sessionData.session.createdAt,
          updatedAt: sessionData.session.updatedAt,
          endedAt: sessionData.session.endedAt,
        } : null}
        status={status}
        onClose={handleCloseSession}
        onDelete={handleDeleteSession}
        onContinue={handleResumeSession}
        resuming={resuming}
        controllerOnline={controllerOnline}
      />
      <MessageList
        messages={messages}
      />
      <InputBox
        onSend={handleSendMessage}
        onStop={handleCancelGeneration}
        disabled={status !== 'running' && status !== 'idling'}
        sending={sending}
        modes={modes}
        currentModeId={currentModeId}
        onSetMode={handleSetMode}
        status={status}
        availableModels={availableModels}
        currentModelId={currentModelId}
        onSetModel={handleSetModel}
      />

      {showNewSessionDialog && (
        <NewSessionDialog
          controllers={controllersData?.controllers || []}
          onClose={() => setShowNewSessionDialog(false)}
          onCreate={handleCreateSession}
        />
      )}
    </div>
  );
}
