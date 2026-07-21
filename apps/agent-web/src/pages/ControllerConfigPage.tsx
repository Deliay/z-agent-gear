import { useState } from 'react';
import { useQuery } from '@apollo/client/react';
import { GET_CONTROLLERS } from '@/graphql/queries';
import type { GetControllersQuery } from '@/graphql/types';
import WorkspaceSection from '@/components/settings/WorkspaceSection';
import HarnessToolsSection from '@/components/settings/HarnessToolsSection';
import { useIsMobile } from '../hooks/useIsMobile';
import MobileBackButton from '../components/MobileBackButton';

interface ControllerConfigPageProps {
  controllerId: string;
  onBack: () => void;
}

export default function ControllerConfigPage({ controllerId, onBack }: ControllerConfigPageProps) {
  const { data: controllerData } = useQuery<GetControllersQuery>(GET_CONTROLLERS);
  const controller = controllerData?.controllers.find((c) => c.id === controllerId);
  const isMobile = useIsMobile();

  const [activeSection, setActiveSection] = useState<'workspace' | 'harness'>('workspace');

  if (isMobile) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <MobileBackButton to="/settings" />
          <span className={`h-2 w-2 rounded-full shrink-0 ${controller?.status === 'online' ? 'bg-success' : 'bg-muted-foreground'}`} />
          <span className="font-medium truncate">{controller?.name || '加载中...'}</span>
        </div>
        <div className="flex gap-1 border-b px-4 py-2">
          <button type="button" onClick={() => setActiveSection('workspace')} className={`rounded-md px-3 py-1.5 text-sm font-medium ${activeSection === 'workspace' ? 'bg-accent' : 'hover:bg-accent'}`}>工作区</button>
          <button type="button" onClick={() => setActiveSection('harness')} className={`rounded-md px-3 py-1.5 text-sm font-medium ${activeSection === 'harness' ? 'bg-accent' : 'hover:bg-accent'}`}>Harness 工具</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {activeSection === 'workspace' && (
            <WorkspaceSection controllerId={controllerId} controllerOnline={controller?.status === 'online'} />
          )}
          {activeSection === 'harness' && (
            <HarnessToolsSection controllerId={controllerId} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full grid-cols-[200px_1fr]">
      <nav className="border-r p-4">
        <div className="space-y-1">
          <button
            type="button"
            onClick={onBack}
            className="w-full rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground"
          >
            ← 返回
          </button>
          <div className="mt-4 flex items-center gap-2 px-3">
          <span className={`h-2 w-2 rounded-full shrink-0 ${controller?.status === 'online' ? 'bg-success' : 'bg-muted-foreground'}`} />
            <span className="font-medium truncate">{controller?.name || '加载中...'}</span>
          </div>
          <div className="mt-6 space-y-1">
            <button
              type="button"
              onClick={() => setActiveSection('workspace')}
              className={`w-full rounded-md px-3 py-2 text-sm text-left ${activeSection === 'workspace' ? 'bg-accent' : 'hover:bg-accent'}`}
            >
              工作区
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('harness')}
              className={`w-full rounded-md px-3 py-2 text-sm text-left ${activeSection === 'harness' ? 'bg-accent' : 'hover:bg-accent'}`}
            >
              可用 Harness 工具
            </button>
          </div>
        </div>
      </nav>
      <div className="overflow-y-auto p-8">
        {activeSection === 'workspace' ? (
          <WorkspaceSection controllerId={controllerId} controllerOnline={controller?.status === 'online'} />
        ) : (
          <HarnessToolsSection controllerId={controllerId} />
        )}
      </div>
    </div>
  );
}
