import { useState, useEffect } from 'react';
import { useQuery } from '@apollo/client/react';
import { BROWSE_FOLDER, GET_HOME_DIRECTORY } from '../../graphql/queries';
import type { FolderEntryData } from '../../graphql/types';
import { Button } from '@/components/ui/button';

interface DirectoryPickerProps {
  controllerId: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export default function DirectoryPicker({ controllerId, onSelect, onClose }: DirectoryPickerProps) {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);

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
      </div>

      <div className="max-h-64 overflow-y-auto rounded-md border">
        {loading ? (
          <div className="p-4 text-center text-sm text-muted-foreground">加载中...</div>
        ) : directories.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">无子目录</div>
        ) : (
          <ul className="divide-y">
            {directories.map((dir) => (
              <li key={dir.path}>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => handleNavigate(dir.path)}
                >
                  📁 {dir.name}
                </button>
              </li>
            ))}
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
    </div>
  );
}
