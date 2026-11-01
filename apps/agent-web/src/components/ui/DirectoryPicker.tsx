import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@apollo/client/react';
import { BROWSE_FOLDER, GET_HOME_DIRECTORY } from '../../graphql/queries';
import { CREATE_FOLDER } from '../../graphql/mutations';
import { logger } from '@/lib/logger';
import type { FolderEntryData, CreateFolderMutation } from '../../graphql/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface DirectoryPickerProps {
  controllerId: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function getParentPath(path: string): string { // eslint-disable-line react-refresh/only-export-components
  if (path === '/') return '/';
  const normalized = path.replace(/[\\/]+$/, '');
  const lastSep = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (lastSep <= 0) return '/';
  const result = normalized.slice(0, lastSep);
  if (/^[A-Za-z]:$/.test(result)) return result + '\\';
  return result;
}

export default function DirectoryPicker({ controllerId, onSelect, onClose }: DirectoryPickerProps) {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [createFolder] = useMutation<CreateFolderMutation>(CREATE_FOLDER);

  const { data: homeData, loading: homeLoading } = useQuery<{ getHomeDirectory: string | null }>(
    GET_HOME_DIRECTORY,
    { variables: { controllerId } },
  );

  const { data: folderData, loading: folderLoading } = useQuery<{ browseFolder: FolderEntryData[] }>(
    BROWSE_FOLDER,
    { variables: { controllerId, path: currentPath }, skip: currentPath === null },
  );

  useEffect(() => {
    if (homeData?.getHomeDirectory && currentPath === null) {
      setCurrentPath(homeData.getHomeDirectory);
    }
  }, [homeData, currentPath]);

  const entries = folderData?.browseFolder ?? [];
  const directories = entries.filter((e) => e.isDirectory);
  const parentPath = currentPath ? getParentPath(currentPath) : null;
  const isRoot = parentPath === currentPath;

  const handleNavigate = (path: string) => {
    setHistory((prev) => [...prev, currentPath!]);
    setCurrentPath(path);
  };

  const handleBack = () => {
    if (history.length > 0) {
      const prev = history[history.length - 1];
      setHistory((h) => h.slice(0, -1));
      setCurrentPath(prev);
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || !currentPath) return;
    try {
      const { data } = await createFolder({
        variables: {
          controllerId,
          parentPath: currentPath,
          folderName: newFolderName.trim(),
        },
      });
      if (data?.createFolder?.path) {
        setHistory((prev) => [...prev, currentPath!]);
        setCurrentPath(data.createFolder.path);
      }
    } catch (err) {
      logger.error({ err }, 'Failed to create folder');
    }
    setShowNewFolder(false);
    setNewFolderName('');
  };

  const handleSelect = () => {
    if (currentPath) {
      onSelect(currentPath);
    }
  };

  const loading = homeLoading || folderLoading;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleBack}
          disabled={history.length === 0}
        >
          ←
        </Button>
        <div className="flex-1 truncate text-sm text-muted-foreground">
          {currentPath || '...'}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowNewFolder(true)}
        >
          + 新建文件夹
        </Button>
      </div>

      <div className="max-h-64 overflow-y-auto rounded-md border">
        {loading ? (
          <div className="p-4 text-center text-sm text-muted-foreground">加载中...</div>
        ) : (
          <ul className="divide-y">
            {!isRoot && parentPath && (
              <li>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => handleNavigate(parentPath)}
                >
                  .. 返回上级
                </button>
              </li>
            )}
            {directories.length === 0 ? (
              <li className="p-4 text-center text-sm text-muted-foreground">无子目录</li>
            ) : (
              directories.map((dir) => (
                <li key={dir.path}>
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
                    onClick={() => handleNavigate(dir.path)}
                  >
                    📁 {dir.name}
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>
          取消
        </Button>
        <Button size="sm" onClick={handleSelect} disabled={!currentPath}>
          选择此目录
        </Button>
      </div>
    {showNewFolder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm rounded-lg bg-card p-6 shadow-xl">
            <h3 className="mb-4 text-base font-semibold">新建文件夹</h3>
            <Input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="文件夹名称"
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); }}
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowNewFolder(false)}>
                取消
              </Button>
              <Button size="sm" onClick={handleCreateFolder} disabled={!newFolderName.trim()}>
                创建
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
