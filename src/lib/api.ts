export interface SessionUser {
  id: number;
  uid: string;
  email: string | null;
  displayName: string;
  role: 'owner' | 'admin' | 'support' | 'customer';
  telegramUserId?: string | null;
}

let activeToken: string | null = null;

export function setAuthToken(token: string | null) {
  activeToken = token;
}

export function getAuthToken(): string | null {
  return activeToken;
}

export async function apiFetch<T = any>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };

  if (activeToken && !headers.Authorization) {
    headers.Authorization = `Bearer ${activeToken}`;
  }

  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text };
  }

  if (!res.ok) {
    const err = new Error(
      json?.error || json?.messageAr || json?.message || `HTTP ${res.status}`
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  return json as T;
}
