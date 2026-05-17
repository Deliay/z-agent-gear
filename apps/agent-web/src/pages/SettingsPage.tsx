import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
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

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    el?.scrollIntoView({ behavior: 'smooth' });
  };

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
              控制器
            </div>
            <button
              type="button"
              onClick={() => scrollTo('controller-section')}
              className="w-full rounded-md px-3 py-2 text-sm font-medium text-left hover:bg-accent hover:text-accent-foreground"
            >
              控制器管理
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

        <section id="provider-section" className="mb-10">
          <ProviderSection />
        </section>

        <section id="model-section" className="mb-10">
          <ModelSection />
        </section>

        <section id="controller-section" className="mb-10">
          <ControllerListSection />
        </section>
      </div>
    </div>
  );
}
