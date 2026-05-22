import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import WorkspaceSection from './WorkspaceSection';

interface WorkspaceManagerDialogProps {
  controllerId: string;
  controllerName: string;
  controllerOnline?: boolean;
  onClose: () => void;
}

export default function WorkspaceManagerDialog({ controllerId, controllerName, controllerOnline = false, onClose }: WorkspaceManagerDialogProps) {
  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>管理工作区</DialogTitle>
          <DialogDescription>
            管理控制器「{controllerName}」的工作区目录
          </DialogDescription>
        </DialogHeader>

        <WorkspaceSection controllerId={controllerId} controllerOnline={controllerOnline} />

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
