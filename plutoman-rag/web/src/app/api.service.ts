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
  /** Tables the database computed for the question (counts, lists, comparisons). */
  tables?: ResultTable[];
  coverage?: { reportsTotal: number; reportsInResult: number | null };
}

export interface ResultTable {
  title: string;
  columns: string[];
  rows: Record<string, string | number | null>[];
}

/** Progress of a streamed answer (POST /chat/stream). */
export interface ChatStreamHandlers {
  onStage?: (stage: 'searching' | 'writing' | 'checking') => void;
  onDelta?: (text: string) => void;
}

export interface Usage {
  tenantId: string;
  date: string;
  searches: number;
  genTokens: number;
}

/** A document the user uploaded, with its indexing status. */
export interface UploadItem {
  id: string;
  filename: string;
  sizeBytes: number;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error: string | null;
  chunkCount: number | null;
}

export interface UploadLimits {
  maxMb: number;
  maxFiles: number;
  extensions: string[];
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

  /**
   * Same turn as chat(), read as server-sent events: stages and the draft
   * arrive while the answer is written; the returned response is the checked
   * answer and replaces the draft.
   */
  async chatStream(
    token: string,
    body: { conversationId?: string | null; message: string; filters?: SearchFilters; topK?: number; generate?: boolean },
    handlers: ChatStreamHandlers
  ): Promise<ChatResponse> {
    const payload: Record<string, unknown> = {
      message: body.message,
      filters: body.filters,
      topK: body.topK,
      generate: body.generate,
    };
    if (body.conversationId) payload['conversationId'] = body.conversationId;
    const res = await fetch(`${API_BASE}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) throw { status: res.status };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let final: ChatResponse | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      // Events are separated by a blank line.
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        const parsed = JSON.parse(data);
        if (event === 'status') handlers.onStage?.(parsed.stage);
        else if (event === 'delta') handlers.onDelta?.(parsed.text);
        else if (event === 'final') final = parsed as ChatResponse;
        else if (event === 'error') throw { status: 500 };
      }
    }
    if (!final) throw { status: 500 };
    return final;
  }

  async usage(token: string): Promise<Usage> {
    return firstValueFrom(
      this.http.get<Usage>(`${API_BASE}/usage`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
  }

  async listUploads(token: string): Promise<{ uploads: UploadItem[]; limits: UploadLimits }> {
    return firstValueFrom(
      this.http.get<{ uploads: UploadItem[]; limits: UploadLimits }>(`${API_BASE}/uploads`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
  }

  /** Upload one file; the API indexes it in the background. */
  async uploadFile(token: string, file: File): Promise<UploadItem> {
    const fileBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      // readAsDataURL yields "data:<type>;base64,<payload>" — keep the payload.
      reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const res = await firstValueFrom(
      this.http.post<{ upload: UploadItem }>(
        `${API_BASE}/uploads`,
        { filename: file.name, fileBase64 },
        { headers: { Authorization: `Bearer ${token}` } }
      )
    );
    return res.upload;
  }

  async deleteUpload(token: string, id: string): Promise<void> {
    await firstValueFrom(
      this.http.delete(`${API_BASE}/uploads/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
  }
}
