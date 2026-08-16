// API client for making requests to the backend

const API_BASE = '/api';

async function handleResponse<T>(response: Response): Promise<T> {
  // Parse defensively: not every failure comes back as JSON. A proxy 504 or 502 is an HTML
  // page and an empty 413 is nothing at all, and parsing before the ok check turned those
  // into "Unexpected token '<'" — which names the parser, not the timeout. Bulk actions make
  // that the expected failure of a long-running call, so it has to read correctly.
  const body = await response.text();
  let data: { error?: string } | null = null;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem('auth-storage');
      window.location.href = '/login';
    }
    throw new Error(
      data?.error || `${response.status} ${response.statusText || 'Request failed'}`
    );
  }

  if (data === null && body) throw new Error('The server sent a response that could not be read');
  return data as T;
}

export const api = {
  // Generic request methods
  async get<T>(endpoint: string): Promise<T> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      credentials: 'include',
    });
    return handleResponse<T>(response);
  },

  async post<T>(endpoint: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    return handleResponse<T>(response);
  },

  async postForm<T>(endpoint: string, form: FormData): Promise<T> {
    // No Content-Type header — the browser sets the multipart boundary.
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      body: form,
      credentials: 'include',
    });
    return handleResponse<T>(response);
  },

  async put<T>(endpoint: string, body: unknown): Promise<T> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    return handleResponse<T>(response);
  },

  async patch<T>(endpoint: string, body: unknown): Promise<T> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    return handleResponse<T>(response);
  },

  async delete<T>(endpoint: string): Promise<T> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return handleResponse<T>(response);
  },
};

// Response types
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface DataResponse<T> {
  data: T;
  message?: string;
}

export interface MessageResponse {
  message: string;
}
