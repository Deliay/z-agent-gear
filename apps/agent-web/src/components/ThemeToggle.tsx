import { Moon, Sun, Monitor } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';

const themeOrder = ['light', 'dark', 'system'] as const;

const themeLabels = {
  light: '明亮模式',
  dark: '黑暗模式',
  system: '跟随系统',
};

const themeIcons = {
  light: Moon,
  dark: Sun,
  system: Monitor,
};

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const handleClick = () => {
    const currentIndex = themeOrder.indexOf(theme);
    const nextIndex = (currentIndex + 1) % themeOrder.length;
    setTheme(themeOrder[nextIndex]);
  };

  const Icon = themeIcons[theme];
  const label = themeLabels[theme];

  return (
    <button
      type="button"
      onClick={handleClick}
      className="rounded p-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
