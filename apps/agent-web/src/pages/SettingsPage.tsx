import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
import { useIsMobile } from '../hooks/useIsMobile';
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
import McpServerSection from '@/components/settings/McpServerSection';
import GithubBindingSection from '@/components/settings/GithubBindingSection';
import ControllerConfigPage from './ControllerConfigPage';

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isMobile = useIsMobile();

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

  if (isMobile) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <MobileBackButton to="/sessions" />
          <h1 className="text-lg font-semibold">设置</h1>
        </div>
        <div className="flex gap-1 overflow-x-auto border-b px-4 py-2">
          <button type="button" onClick={() => scrollTo('account-section')} className="shrink-0 rounded-md px-3 py-1.5 text-sm font-medium hover:bg-accent">帐号</button>
          <button type="button" onClick={() => scrollTo('github-section')} className="shrink-0 rounded-md px-3 py-1.5 text-sm font-medium hover:bg-accent">GitHub</button>
          <button type="button" onClick={() => scrollTo('provider-section')} className="shrink-0 rounded-md px-3 py-1.5 text-sm font-medium hover:bg-accent">供应商</button>
          <button type="button" onClick={() => scrollTo('model-section')} className="shrink-0 rounded-md px-3 py-1.5 text-sm font-medium hover:bg-accent">模型</button>
          <button type="button" onClick={() => scrollTo('controller-section')} className="shrink-0 rounded-md px-3 py-1.5 text-sm font-medium hover:bg-accent">控制器</button>
          <button type="button" onClick={() => scrollTo('mcp-section')} className="shrink-0 rounded-md px-3 py-1.5 text-sm font-medium hover:bg-accent">MCP</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <section id="account-section" className="mb-8">
            <h2 className="mb-4 text-lg font-semibold">帐号</h2>
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
                      <Button variant="destructive" onClick={handleLogout}>退出</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardContent>
            </Card>
          </section>
          <section id="github-section" className="mb-8">
            <GithubBindingSection />
          </section>
          <section id="provider-section" className="mb-8">
            <ProviderSection />
          </section>
          <section id="model-section" className="mb-8">
            <ModelSection />
          </section>
          <section id="controller-section" className="mb-8">
            <ControllerListSection onNavigateToConfig={handleNavigateToConfig} />
          </section>
          <section id="mcp-section" className="mb-8">
            <h2 className="mb-4 text-lg font-semibold">MCP</h2>
            <div className="space-y-4">
              <McpProxyKeySection />
              <McpServerSection />
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full grid-cols-[200px_1fr]">
      <nav className="border-r p-4" aria-label="Settings navigation">
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => scrollTo('account-section')}
            className="w-full rounded-md px-3 py-2 text-sm font-medium text-left hover:bg-accent hover:text-accent-foreground"
          >
            帐号
          </button>
          <div className="pt-2">
            <div className="px-3 pb-1 text-xs font-medium text-muted-foreground">
              GitHub
            </div>
            <button
              type="button"
              onClick={() => scrollTo('github-section')}
              className="w-full rounded-md px-3 py-2 text-sm font-medium text-left hover:bg-accent hover:text-accent-foreground"
            >
              GitHub 绑定
            </button>
          </div>
          <div className="pt-2">
            <div className="px-3 pb-1 text-xs font-medium text-muted-foreground">
              模型设置
            </div>
            <button
              type="button"
              onClick={() => scrollTo('provider-section')}
              className="w-full rounded-md px-3 py-2 text-sm font-medium text-left hover:bg-accent hover:text-accent-foreground"
            >
              供应商设置
            </button>
            <button
              type="button"
              onClick={() => scrollTo('model-section')}
              className="w-full rounded-md px-3 py-2 text-sm font-medium text-left hover:bg-accent hover:text-accent-foreground"
            >
              可用模型
            </button>
          </div>
          <div className="pt-2">
            <div className="px-3 pb-1 text-xs font-medium text-muted-foreground">
              本地控制器
            </div>
            <button
              type="button"
              onClick={() => scrollTo('controller-section')}
              className="w-full rounded-md px-3 py-2 text-sm font-medium text-left hover:bg-accent hover:text-accent-foreground"
            >
              控制器管理
            </button>
          </div>
          <div className="pt-2">
            <div className="px-3 pb-1 text-xs font-medium text-muted-foreground">
              MCP 代理
            </div>
            <button
              type="button"
              onClick={() => scrollTo('mcp-section')}
              className="w-full rounded-md px-3 py-2 text-sm font-medium text-left hover:bg-accent hover:text-accent-foreground"
            >
              MCP 管理
            </button>
          </div>
        </div>
      </nav>
      <div className="overflow-y-auto p-8">
          <section id="account-section" className="mb-10">
            <h2 className="mb-6 text-xl font-semibold text-foreground">帐号</h2>
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

          <section id="github-section" className="mb-10">
            <GithubBindingSection />
          </section>

          <section id="provider-section" className="mb-10">
            <ProviderSection />
          </section>

        <section id="model-section" className="mb-10">
          <ModelSection />
        </section>

        <section id="controller-section" className="mb-10">
          <ControllerListSection onNavigateToConfig={handleNavigateToConfig} />
        </section>

        <section id="mcp-section" className="mb-10">
          <h2 className="mb-6 text-xl font-semibold text-foreground">MCP 代理</h2>
          <div className="space-y-6">
            <McpProxyKeySection />
            <McpServerSection />
          </div>
        </section>
      </div>
    </div>
  );
}
