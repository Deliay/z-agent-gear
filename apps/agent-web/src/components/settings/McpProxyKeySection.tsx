import { useState, useEffect } from 'react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Trash2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchMcpProxyKeys,
  createMcpProxyKey,
  revokeMcpProxyKey,
  type McpProxyKey,
} from '@/api/mcp-proxy';

export default function McpProxyKeySection() {
  const { token } = useAuth();
  const [keys, setKeys] = useState<McpProxyKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  useEffect(() => {
    loadKeys();
  }, []);

  const loadKeys = async () => {
    try {
      setLoading(true);
      const data = await fetchMcpProxyKeys(token!);
      setKeys(data);
    } catch (err) {
      toast.error('Failed to load MCP proxy keys');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!newKeyName.trim()) {
      toast.error('Please enter a key name');
      return;
    }

    try {
      const result = await createMcpProxyKey(token!, newKeyName.trim());
      setKeys([result.key, ...keys]);
      setCreatedKey(result.rawKey);
      setNewKeyName('');
      toast.success('MCP proxy key created');
    } catch (err) {
      toast.error('Failed to create MCP proxy key');
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokeMcpProxyKey(token!, id);
      setKeys(keys.map(k => k.id === id ? { ...k, status: 'revoked' } : k));
      toast.success('MCP proxy key revoked');
    } catch (err) {
      toast.error('Failed to revoke MCP proxy key');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>MCP Proxy Keys</CardTitle>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger render={<Button size="sm" />}>
              <Plus className="mr-2 h-4 w-4" />
              Generate Key
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Generate MCP Proxy Key</DialogTitle>
              <DialogDescription>
                Create a new key to register local MCP commands as proxies.
              </DialogDescription>
            </DialogHeader>
            {createdKey ? (
              <div className="space-y-4">
                <div className="rounded-md bg-muted p-4">
                  <p className="text-sm font-medium mb-2">Your new MCP proxy key:</p>
                  <code className="text-sm break-all">{createdKey}</code>
                </div>
                <p className="text-sm text-muted-foreground">
                  Copy this key now. You won't be able to see it again.
                </p>
                <DialogFooter>
                  <Button onClick={() => {
                    copyToClipboard(createdKey);
                    setCreatedKey(null);
                    setDialogOpen(false);
                  }}>
                    Copy & Close
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="keyName">Key Name</Label>
                  <Input
                    id="keyName"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="e.g., My Development Machine"
                  />
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleCreate}>Generate</Button>
                </DialogFooter>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No MCP proxy keys yet. Generate one to start registering local MCP commands.
          </p>
        ) : (
          <div className="space-y-4">
            {keys.map((key) => (
              <div
                key={key.id}
                className="flex items-center justify-between rounded-lg border p-4"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{key.name}</span>
                    <Badge variant={key.status === 'active' ? 'default' : 'secondary'}>
                      {key.status}
                    </Badge>
                  </div>
                  <code className="text-sm text-muted-foreground">{key.keyPrefix}</code>
                  {key.lastUsedAt && (
                    <p className="text-xs text-muted-foreground">
                      Last used: {new Date(key.lastUsedAt).toLocaleString()}
                    </p>
                  )}
                </div>
                {key.status === 'active' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRevoke(key.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
