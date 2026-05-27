import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DirectoryPicker, { getParentPath } from './DirectoryPicker';

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

function mockQuery(overrides: Record<string, unknown> = {}) {
  return { data: null, loading: false, error: null, refetch: vi.fn(), ...overrides };
}

describe('getParentPath', () => {
  it('should return / for root', () => {
    expect(getParentPath('/')).toBe('/');
  });

  it('should return parent for nested Linux path', () => {
    expect(getParentPath('/home/ash')).toBe('/home');
  });

  it('should return / for second-level path', () => {
    expect(getParentPath('/home')).toBe('/');
  });

  it('should handle trailing slash', () => {
    expect(getParentPath('/home/ash/')).toBe('/home');
  });

  it('should return / for Windows drive root', () => {
    expect(getParentPath('C:\\')).toBe('/');
  });

  it('should return parent for nested Windows path', () => {
    expect(getParentPath('C:\\Users\\ash')).toBe('C:\\Users');
  });

  it('should return C:\\ for Windows second-level path', () => {
    expect(getParentPath('C:\\Users')).toBe('C:\\');
  });

  it('should handle Windows trailing backslash', () => {
    expect(getParentPath('C:\\Users\\ash\\')).toBe('C:\\Users');
  });
});

describe('DirectoryPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMutation.mockReturnValue([vi.fn()]);
  });

  function setupQueries(currentPath: string, directories: Array<{ name: string; path: string; isDirectory: boolean }> = []) {
    mockUseQuery.mockImplementation((_query: unknown, options: Record<string, unknown>) => {
      const variables = options?.variables as Record<string, unknown> | undefined;
      if (variables?.controllerId && !options?.skip) {
        // GET_HOME_DIRECTORY query
        return mockQuery({ data: { getHomeDirectory: currentPath } });
      }
      // BROWSE_FOLDER query
      return mockQuery({ data: { browseFolder: directories } });
    });
  }

  it('should show ".. 返回上级" when not at root', () => {
    setupQueries('/home/ash', [
      { name: 'Documents', path: '/home/ash/Documents', isDirectory: true },
    ]);
    render(<DirectoryPicker controllerId="ctrl-1" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('.. 返回上级')).toBeDefined();
  });

  it('should NOT show ".. 返回上级" at Linux root', () => {
    setupQueries('/', [
      { name: 'home', path: '/home', isDirectory: true },
    ]);
    render(<DirectoryPicker controllerId="ctrl-1" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText('.. 返回上级')).toBeNull();
  });

  it('should show ".. 返回上级" for Windows drive root C:\\', () => {
    setupQueries('C:\\', [
      { name: 'Users', path: 'C:\\Users', isDirectory: true },
    ]);
    render(<DirectoryPicker controllerId="ctrl-1" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('.. 返回上级')).toBeDefined();
  });

  it('should navigate to parent when clicking ".. 返回上级"', () => {
    setupQueries('/home/ash', [
      { name: 'Documents', path: '/home/ash/Documents', isDirectory: true },
    ]);
    render(<DirectoryPicker controllerId="ctrl-1" onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('.. 返回上级'));
    // After clicking, currentPath should change to /home (parent of /home/ash)
    // This triggers a new BROWSE_FOLDER query with path=/home
  });

  it('should show "无子目录" when at root with no directories', () => {
    setupQueries('/', []);
    render(<DirectoryPicker controllerId="ctrl-1" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('无子目录')).toBeDefined();
    expect(screen.queryByText('.. 返回上级')).toBeNull();
  });

  it('should show "无子目录" and ".. 返回上级" when not at root with no directories', () => {
    setupQueries('/home/ash', []);
    render(<DirectoryPicker controllerId="ctrl-1" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('无子目录')).toBeDefined();
    expect(screen.getByText('.. 返回上级')).toBeDefined();
  });
});
