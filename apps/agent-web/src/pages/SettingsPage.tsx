import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
import MobileBackButton from '../components/MobileBackButton';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import ProviderSection from '@/components/settings/ProviderSection';
import ModelSection from '@/components/settings/ModelSection';
import ControllerListSection from '@/components/settings/ControllerListSection';
import McpProxyKeySection from '@/components/settings/McpProxyKeySection';
import McpRegistrySection from '@/components/settings/McpRegistrySection';
import GithubBindingSection from '@/components/settings/GithubBindingSection';
import CommitSettingsSection from '@/components/settings/CommitSettingsSection';
import WorkflowSection from '@/components/settings/WorkflowSection';
import ControllerConfigPage from './ControllerConfigPage';
import {
  User,
  GitBranch,
  Boxes,
  Cpu,
  Server,
  Puzzle,
  Workflow,
} from 'lucide-react';

const NAV_ITEMS = [
  { id: 'account-section', label: '帐号', icon: User },
  { id: 'github-section', label: 'GitHub 绑定', icon: GitBranch },
  { id: 'provider-section', label: '供应商设置', icon: Boxes },
  { id: 'model-section', label: '可用模型', icon: Cpu },
  { id: 'controller-section', label: '控制器管理', icon: Server },
  { id: 'mcp-section', label: 'MCP 管理', icon: Puzzle },
  { id: 'workflow-section', label: '工作流', icon: Workflow },
];

const NAV_GROUPS = [
  { label: '帐号', items: [NAV_ITEMS[0]] },
  { label: 'GitHub', items: [NAV_ITEMS[1]] },
  { label: '模型设置', items: [NAV_ITEMS[2], NAV_ITEMS[3]] },
  { label: '本地控制器', items: [NAV_ITEMS[4]] },
  { label: 'MCP 代理', items: [NAV_ITEMS[5]] },
  { label: '工作流', items: [NAV_ITEMS[6]] },
];

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const controllerId = searchParams.get('controllerId');

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    el?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleNavigateToConfig = (id: string) => {
    setSearchParams({ controllerId: id });
  };

  if (controllerId) {
    return (
      <ControllerConfigPage
        controllerId={controllerId}
        onBack={() => setSearchParams({})}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3 md:hidden">
        <MobileBackButton to="/sessions" />
        <h1 className="text-lg font-semibold">设置</h1>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b px-4 py-2 md:hidden">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => scrollTo(item.id)}
            className="shrink-0 rounded-md px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="flex flex-1 overflow-hidden md:grid md:grid-cols-[200px_1fr]">
        <nav className="hidden border-r p-4 md:block" aria-label="Settings navigation">
          <div className="space-y-1">
            {NAV_GROUPS.map((group) => (
              <div key={group.label} className="pt-2 first:pt-0">
                {group.items.length > 1 && (
                  <div className="px-3 pb-1 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </div>
                )}
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => scrollTo(item.id)}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-left hover:bg-accent hover:text-accent-foreground"
                  >
                    <item.icon className="size-4 text-muted-foreground" />
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </nav>

        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          <section id="account-section" className="mb-8 md:mb-10">
            <h2 className="mb-4 text-lg font-semibold md:mb-6 md:text-xl text-foreground">帐号</h2>
            <Card>
              <CardHeader>
                <CardTitle>个人资料</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <span className="block text-sm font-medium text-muted-foreground">用户名</span>
                  <p className="mt-1 text-foreground">{user?.username ?? ''}</p>
                </div>
                <Dialog>
                  <DialogTrigger render={<Button variant="destructive">退出登录</Button>} />
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>确认退出</DialogTitle>
                      <DialogDescription>确定要退出登录吗？</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <DialogTrigger render={<Button variant="outline">取消</Button>} />
                      <Button variant="destructive" onClick={handleLogout}>
                        退出
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardContent>
            </Card>
          </section>

          <section id="github-section" className="mb-8 md:mb-10">
            <GithubBindingSection />
            <CommitSettingsSection />
          </section>

          <section id="provider-section" className="mb-8 md:mb-10">
            <ProviderSection />
          </section>

          <section id="model-section" className="mb-8 md:mb-10">
            <ModelSection />
          </section>

          <section id="controller-section" className="mb-8 md:mb-10">
            <ControllerListSection onNavigateToConfig={handleNavigateToConfig} />
          </section>

          <section id="mcp-section" className="mb-8 md:mb-10">
            <h2 className="mb-4 text-lg font-semibold md:mb-6 md:text-xl text-foreground">MCP 代理</h2>
            <div className="space-y-4 md:space-y-6">
              <McpProxyKeySection />
              <McpRegistrySection />
            </div>
          </section>

          <section id="workflow-section" className="mb-8 md:mb-10">
            <h2 className="mb-4 text-lg font-semibold md:mb-6 md:text-xl text-foreground">工作流</h2>
            <WorkflowSection />
          </section>
        </div>
      </div>
    </div>
  );
}
