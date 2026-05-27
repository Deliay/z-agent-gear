import { useNavigate } from 'react-router-dom';

interface MobileBackButtonProps {
  to?: string;
  label?: string;
}

export default function MobileBackButton({ to, label = '返回' }: MobileBackButtonProps) {
  const navigate = useNavigate();

  return (
    <button
      type="button"
      onClick={() => (to ? navigate(to) : navigate(-1))}
      className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm text-gray-600 hover:text-gray-900 md:hidden"
    >
      ← {label}
    </button>
  );
}
