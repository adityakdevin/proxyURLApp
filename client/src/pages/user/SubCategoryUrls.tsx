import { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api, DataResponse } from '@/lib/api';
import { useToast } from '@/components/ui/use-toast';
import { Link2, ChevronRight, AlertCircle } from 'lucide-react';

interface UrlItem {
  id: string;
  label: string;
  description: string | null;
  opaqueId: string;
}

interface SubCategoryData {
  subCategory: {
    id: string;
    name: string;
    description: string | null;
  };
  category: {
    id: string;
    name: string;
  };
  urls: UrlItem[];
}

export default function SubCategoryUrls() {
  const { subCategoryId } = useParams<{ subCategoryId: string }>();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<SubCategoryData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSubCategoryUrls = async () => {
    if (!subCategoryId) return;

    setIsLoading(true);
    setError(null);
    try {
      const response = await api.get<DataResponse<SubCategoryData>>(`/user/subcategory/${subCategoryId}`);
      setData(response.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load URLs';
      setError(message);
      toast({
        title: 'Error',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSubCategoryUrls();
  }, [subCategoryId]);

  const handleUrlClick = (opaqueId: string) => {
    navigate(`/view/${opaqueId}`);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
        <div>
          <h3 className="font-medium text-red-800">Error</h3>
          <p className="text-sm text-red-700">{error}</p>
          <Link to="/dashboard" className="text-sm text-red-600 hover:underline mt-2 inline-block">
            Return to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <div>
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-gray-500 mb-4">
        <Link to="/dashboard" className="hover:text-gray-700">
          Dashboard
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-gray-600">{data.category.name}</span>
        <ChevronRight className="h-4 w-4" />
        <span className="text-gray-900 font-medium">{data.subCategory.name}</span>
      </nav>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{data.subCategory.name}</h1>
        {data.subCategory.description && (
          <p className="text-gray-500 mt-1">{data.subCategory.description}</p>
        )}
      </div>

      {/* URLs Grid */}
      {data.urls.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.urls.map((url) => (
            <button
              key={url.id}
              onClick={() => handleUrlClick(url.opaqueId)}
              className="bg-white p-4 rounded-lg shadow border hover:border-blue-300 hover:shadow-md transition-all text-left group"
            >
              <div className="flex items-start gap-3">
                <div className="p-2 bg-blue-50 rounded-lg group-hover:bg-blue-100 transition-colors">
                  <Link2 className="h-5 w-5 text-blue-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium text-gray-900 group-hover:text-blue-600 transition-colors truncate">
                    {url.label}
                  </h3>
                  {url.description && (
                    <p className="text-sm text-gray-500 mt-1 line-clamp-2">
                      {url.description}
                    </p>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="bg-gray-50 border rounded-lg p-8 text-center">
          <Link2 className="h-12 w-12 text-gray-300 mx-auto mb-3" />
          <h3 className="text-gray-600 font-medium">No URLs Available</h3>
          <p className="text-sm text-gray-400 mt-1">
            There are no URLs configured for this sub-category.
          </p>
        </div>
      )}

      {/* URL Count */}
      {data.urls.length > 0 && (
        <p className="text-sm text-gray-500 mt-4">
          {data.urls.length} URL{data.urls.length !== 1 ? 's' : ''} available
        </p>
      )}
    </div>
  );
}
