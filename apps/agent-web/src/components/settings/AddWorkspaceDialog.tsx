import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import DirectoryPicker from '../ui/DirectoryPicker';

interface AddWorkspaceDialogProps {
  controllerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
}

export default function AddWorkspaceDialog({ controllerId, open, onOpenChange, onSelect }: AddWorkspaceDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加工作区</DialogTitle>
          <DialogDescription>
            选择要添加到工作区的目录
          </DialogDescription>
        </DialogHeader>
        <DirectoryPicker
          controllerId={controllerId}
          onSelect={onSelect}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
