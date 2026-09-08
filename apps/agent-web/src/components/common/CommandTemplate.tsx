import { useState } from 'react';
import { buildControllerCommand, type Pm2Result } from '@/lib/command-template';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectPopup,
} from '@/components/ui/select';
import { Copy, Check } from 'lucide-react';

type PackageManager = 'npm' | 'pnpm' | 'bun' | 'pm2';
type ServerRegion = 'global' | 'cn';

interface CommandTemplateProps {
  keyValue: string;
}

export default function CommandTemplate({ keyValue }: CommandTemplateProps) {
  const [pm, setPm] = useState<PackageManager>('npm');
  const [region, setRegion] = useState<ServerRegion>('cn');
  const [copied, setCopied] = useState(false);

  const result = buildControllerCommand({ pm, region, key: keyValue });
  const isPm2Result = (r: string | Pm2Result): r is Pm2Result => {
    return typeof r !== 'string' && 'installHint' in r;
  };
  const isPm2 = pm === 'pm2';

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-3 mt-3 p-3 rounded-lg bg-muted/50">
      <div className="flex gap-2">
        <Select value={pm} onValueChange={(v) => setPm(v as PackageManager)}>
          <SelectTrigger className="w-[100px]">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="npm">npm</SelectItem>
            <SelectItem value="pnpm">pnpm</SelectItem>
            <SelectItem value="bun">bun</SelectItem>
            <SelectItem value="pm2">pm2</SelectItem>
          </SelectPopup>
        </Select>

        <Select value={region} onValueChange={(v) => setRegion(v as ServerRegion)}>
          <SelectTrigger className="w-[80px]">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="cn">国内</SelectItem>
            <SelectItem value="global">全球</SelectItem>
          </SelectPopup>
        </Select>
      </div>

      {isPm2 && isPm2Result(result) ? (
        <div className="space-y-2">
          <div className="relative">
            <pre className="p-2 rounded bg-background text-xs font-mono break-all whitespace-pre-wrap">
              {result.installHint}
            </pre>
            <Button
              variant="ghost"
              size="sm"
              className="absolute top-1 right-1 h-6 px-2"
              onClick={() => handleCopy(result.installHint)}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </Button>
          </div>
          <div className="relative">
            <pre className="p-2 rounded bg-background text-xs font-mono break-all whitespace-pre-wrap">
              {result.pm2ConfigJson}
            </pre>
            <Button
              variant="ghost"
              size="sm"
              className="absolute top-1 right-1 h-6 px-2"
              onClick={() => handleCopy(result.pm2ConfigJson)}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </Button>
          </div>
        </div>
      ) : (
        <div className="relative">
          <pre className="p-2 rounded bg-background text-xs font-mono break-all whitespace-pre-wrap">
            {result as string}
          </pre>
          <Button
            variant="ghost"
            size="sm"
            className="absolute top-1 right-1 h-6 px-2"
            onClick={() => handleCopy(result as string)}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </Button>
        </div>
      )}
    </div>
  );
}