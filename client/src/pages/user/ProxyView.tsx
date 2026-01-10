import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';

export default function ProxyView() {
  const { opaqueId } = useParams<{ opaqueId: string }>();
  const navigate = useNavigate();

  const handleExit = () => {
    navigate('/dashboard');
  };

  return (
    <div className="fixed inset-0 bg-white z-50">
      {/* Floating exit button */}
      <Button
        variant="secondary"
        size="sm"
        className="fixed top-4 right-4 z-50 shadow-lg"
        onClick={handleExit}
      >
        <X className="h-4 w-4 mr-2" />
        Exit
      </Button>

      {/* Proxy content iframe */}
      <iframe
        src={`/proxy/${opaqueId}`}
        className="w-full h-full border-0"
        title="Proxied Content"
      />
    </div>
  );
}
