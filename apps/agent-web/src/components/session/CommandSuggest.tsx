import { useEffect, useRef } from 'react';
import { fuzzyMatchWithHighlight } from '../../lib/fuzzyMatch';
import type { Command } from '../../hooks/useCommandState';

interface CommandSuggestProps {
  commands: Command[];
  query: string;
  position: { top: number; left: number };
  onSelect: (command: Command) => void;
  onClose: () => void;
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
}

export default function CommandSuggest({
  commands,
  query,
  position,
  onSelect,
  onClose,
  selectedIndex,
  onSelectedIndexChange,
}: CommandSuggestProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const filteredCommands = commands.filter((cmd) => {
    const { matched } = fuzzyMatchWithHighlight(query, cmd.name);
    return matched;
  });

  useEffect(() => {
    if (filteredCommands.length === 0) {
      onClose();
    }
  }, [filteredCommands.length, onClose]);

  useEffect(() => {
    const selectedElement = listRef.current?.children[selectedIndex] as HTMLElement;
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (filteredCommands.length === 0) {
    return null;
  }

  const renderHighlightedName = (name: string) => {
    const { indices } = fuzzyMatchWithHighlight(query, name);
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;

    indices.forEach((idx, i) => {
      if (idx > lastIndex) {
        parts.push(<span key={`text-${i}`}>{name.slice(lastIndex, idx)}</span>);
      }
      parts.push(
        <span key={`highlight-${i}`} className="font-bold text-blue-600">
          {name[idx]}
        </span>
      );
      lastIndex = idx + 1;
    });

    if (lastIndex < name.length) {
      parts.push(<span key="text-end">{name.slice(lastIndex)}</span>);
    }

    return parts;
  };

  return (
    <div
      className="absolute z-50 max-h-60 w-80 overflow-auto rounded-md border border-gray-200 bg-white shadow-lg"
      style={{ top: position.top, left: position.left }}
    >
      <div ref={listRef} className="py-1">
        {filteredCommands.map((cmd, index) => (
          <div
            key={cmd.name}
            className={`cursor-pointer px-3 py-2 text-sm ${
              index === selectedIndex ? 'bg-blue-50' : 'hover:bg-gray-50'
            }`}
            onClick={() => onSelect(cmd)}
            onMouseEnter={() => onSelectedIndexChange(index)}
          >
            <div className="font-medium">/{renderHighlightedName(cmd.name)}</div>
            {cmd.description && (
              <div className="mt-0.5 text-xs text-gray-500">{cmd.description}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
