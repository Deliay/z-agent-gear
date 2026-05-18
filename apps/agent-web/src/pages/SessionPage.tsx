import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@apollo/client/react';
import {
  GET_SESSION,
  GET_SESSION_MESSAGES,
  GET_CONTROLLERS,
} from '../graphql/queries';
import {
  CREATE_SESSION,
  CLOSE_SESSION,
  DELETE_SESSION,
  SEND_SESSION_MESSAGE,
} from '../graphql/mutations';
import type {
  GetSessionQuery,
  GetSessionMessagesQuery,
  GetControllersQuery,
  CreateSessionMutation,
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

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [showNewSessionDialog, setShowNewSessionDialog] = useState(false);
  const [messages, setMessages] = useState<AcpMessage[]>([]);
  const [status, setStatus] = useState<string>('connecting');

  const { data: sessionData, loading: sessionLoading } = useQuery<GetSessionQuery>(GET_SESSION, {
    variables: { id },
    skip: !id,
  });

  const { data: messagesData, loading: messagesLoading } = useQuery<GetSessionMessagesQuery>(GET_SESSION_MESSAGES, {
    variables: { sessionId: id, limit: 100 },
    skip: !id,
  });

  const { data: controllersData } = useQuery<GetControllersQuery>(GET_CONTROLLERS);

  const [createSession] = useMutation<CreateSessionMutation>(CREATE_SESSION);
  const [closeSession] = useMutation(CLOSE_SESSION);
  const [deleteSession] = useMutation(DELETE_SESSION);
  const [sendMessage] = useMutation(SEND_SESSION_MESSAGE);

  useEffect(() => {
    if (messagesData?.sessionMessages) {
      setMessages(messagesData.sessionMessages);
    }
  }, [messagesData]);

  useEffect(() => {
    if (sessionData?.session) {
      setStatus(sessionData.session.status);
    }
  }, [sessionData]);

  useEffect(() => {
    if (!id) return;

    const eventSource = new EventSource(`/api/session/${id}/stream`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'history') {
        setMessages(data.data);
      } else if (data.type === 'message') {
        setMessages((prev) => [...prev, data.data]);
      } else if (data.type === 'status') {
        setStatus(data.data.status);
      }
    };

    eventSource.onerror = () => {
      console.error('SSE connection error');
    };

    return () => {
      eventSource.close();
    };
  }, [id]);

  const handleCreateSession = async (controllerId: string, cwd?: string) => {
    try {
      const { data } = await createSession({
        variables: {
          input: {
            controllerId,
            acpServerType: 'opencode',
            cwd,
          },
        },
      });
      if (data?.createSession?.session?.id) {
        navigate(`/sessions/${data.createSession.session.id}`);
      }
    } catch (error) {
      console.error('Failed to create session:', error);
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
      await deleteSession({ variables: { id } });
      navigate('/sessions');
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  const handleSendMessage = async (content: string) => {
    if (!id) return;
    try {
      await sendMessage({
        variables: {
          sessionId: id,
          content,
          type: 'text',
        },
      });
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  };

  if (sessionLoading || messagesLoading) {
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
      <SessionHeader
        session={sessionData?.session ?? null}
        status={status}
        onClose={handleCloseSession}
        onDelete={handleDeleteSession}
      />
      <MessageList messages={messages} />
      <InputBox
        onSend={handleSendMessage}
        disabled={status !== 'running'}
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