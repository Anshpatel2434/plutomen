import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/**
 * Base URL of the Retrieval Service. Same-origin path: `ng serve` forwards it
 * to http://localhost:3000 (proxy.conf.json) and the Docker image's nginx
 * forwards it to the api container, so the browser never needs CORS.
 */
export const API_BASE = '/api';

export interface SearchFilters {
  site?: string;
  vendor?: string;
  verdict?: string;
}

export interface RetrievalHit {
  id: string;
  sopId: string;
  sectionPath: string | null;
  question: string | null;
  answer: string | null;
  verdict: string | null;
  site: string | null;
  vendor: string | null;
  content: string;
  score: number;
  /** Report identity + printed page (golden set: "POID-….pdf p.N"). */
  poid?: string | null;
  page?: string | null;
  citation: { sopId: string; sectionPath: string | null; poid?: string | null; page?: string | null };
}

export interface SearchResponse {
  answer: string | null;
  citations: { sopId: string; sectionPath: string | null }[];
  results: RetrievalHit[];
  cached?: boolean;
}

export interface ChatResponse {
  conversationId: string;
  answer: string | null;
  citations: { sopId: string; sectionPath: string | null; poid?: string | null; page?: string | null }[];
  results: RetrievalHit[];
  rewrittenQuery?: string;
}

export interface Usage {
  tenantId: string;
  date: string;
  searches: number;
  genTokens: number;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  constructor(private http: HttpClient) {}

  /** Dev-only: mint a JWT for a tenant (backend must run with DEV_MODE=true). */
  async devToken(tenantId: string, userId = 'demo-user'): Promise<string> {
    const res = await firstValueFrom(
      this.http.post<{ token: string }>(`${API_BASE}/dev/token`, { tenantId, userId })
    );
    return res.token;
  }

  async search(
    token: string,
    body: { query: string; filters?: SearchFilters; topK?: number; generate?: boolean }
  ): Promise<SearchResponse> {
    return firstValueFrom(
      this.http.post<SearchResponse>(`${API_BASE}/search`, body, {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
  }

  async chat(
    token: string,
    body: {
      conversationId?: string | null;
      message: string;
      filters?: SearchFilters;
      topK?: number;
      generate?: boolean;
    }
  ): Promise<ChatResponse> {
    // The backend accepts conversationId as string | undefined (not null), so
    // omit it entirely on the first turn.
    const payload: Record<string, unknown> = {
      message: body.message,
      filters: body.filters,
      topK: body.topK,
      generate: body.generate,
    };
    if (body.conversationId) payload['conversationId'] = body.conversationId;
    return firstValueFrom(
      this.http.post<ChatResponse>(`${API_BASE}/chat`, payload, {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
  }

  async usage(token: string): Promise<Usage> {
    return firstValueFrom(
      this.http.get<Usage>(`${API_BASE}/usage`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
  }
}
