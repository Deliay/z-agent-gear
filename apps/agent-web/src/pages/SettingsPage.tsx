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

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="grid h-full grid-cols-[200px_1fr]">
      <nav className="border-r p-4" aria-label="Settings navigation">
        <div className="space-y-1">
          <div className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground">
            帐号
          </div>
        </div>
      </nav>
      <div className="p-8">
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
      </div>
    </div>
  );
}
