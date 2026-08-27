import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, RetrievalHit, SearchFilters } from './api.service';

interface TenantOption {
  id: string;
  label: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: { sopId: string; sectionPath: string | null }[];
  results?: RetrievalHit[];
  pending?: boolean;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  tenants: TenantOption[] = [
    { id: 'demo-tenant', label: 'Demo Tenant (has data)' },
    { id: 'other-tenant', label: 'Other Tenant (isolation demo)' },
  ];
  tenantId = 'demo-tenant';
  private token = '';
  tokenReady = false;

  // --- conversation state ---
  conversationId: string | null = null;
  messages: ChatMessage[] = [];
  input = '';
  generate = true;
  filters: SearchFilters = {};
  verdictOptions = ['', 'OK', 'NOT OK'];

  sending = false;
  error: string | null = null;
  searchesToday = 0;

  constructor(private api: ApiService) {}

  async ngOnInit(): Promise<void> {
    await this.refreshToken();
  }

  async refreshToken(): Promise<void> {
    this.tokenReady = false;
    this.error = null;
    try {
      this.token = await this.api.devToken(this.tenantId);
      this.tokenReady = true;
      await this.refreshUsage();
    } catch {
      this.error =
        'Could not reach the API / mint a dev token. Is the backend running with DEV_MODE=true on :3000?';
    }
  }

  async onTenantChange(): Promise<void> {
    // Switching tenant starts a fresh conversation (and proves isolation).
    this.conversationId = null;
    this.messages = [];
    await this.refreshToken();
  }

  newConversation(): void {
    this.conversationId = null;
    this.messages = [];
    this.error = null;
  }

  private cleanFilters(): SearchFilters {
    const f: SearchFilters = {};
    if (this.filters.site?.trim()) f.site = this.filters.site.trim();
    if (this.filters.vendor?.trim()) f.vendor = this.filters.vendor.trim();
    if (this.filters.verdict) f.verdict = this.filters.verdict;
    return f;
  }

  /** Sources shown in the side panel = the latest assistant turn's results. */
  get latestResults(): RetrievalHit[] {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'assistant' && m.results) return m.results;
    }
    return [];
  }

  async send(): Promise<void> {
    const text = this.input.trim();
    if (!text || !this.tokenReady || this.sending) return;
    this.error = null;
    this.messages.push({ role: 'user', content: text });
    const placeholder: ChatMessage = { role: 'assistant', content: '', pending: true };
    this.messages.push(placeholder);
    this.input = '';
    this.sending = true;
    try {
      const res = await this.api.chat(this.token, {
        conversationId: this.conversationId,
        message: text,
        filters: this.cleanFilters(),
        generate: this.generate,
      });
      this.conversationId = res.conversationId;
      placeholder.pending = false;
      placeholder.content =
        res.answer ??
        (res.results.length
          ? '(Retrieval-only — generation off. See sources on the right.)'
          : 'No matching content found for this tenant.');
      placeholder.citations = res.citations;
      placeholder.results = res.results;
    } catch (e: any) {
      placeholder.pending = false;
      if (e?.status === 429) {
        placeholder.content = '';
        this.error = 'Rate limited (429) — too many requests this minute. Try again shortly.';
      } else {
        placeholder.content = '';
        this.error = 'Request failed. Check the backend logs.';
      }
      // drop the empty placeholder on error
      this.messages = this.messages.filter((m) => m !== placeholder);
    } finally {
      this.sending = false;
      await this.refreshUsage();
    }
  }

  private async refreshUsage(): Promise<void> {
    try {
      const u = await this.api.usage(this.token);
      this.searchesToday = u.searches;
    } catch {
      /* non-fatal */
    }
  }

  verdictClass(v: string | null): string {
    if (!v) return 'neutral';
    return v.toUpperCase().includes('NOT') ? 'fail' : 'pass';
  }

  /** Turn [sopId | section] citations in the answer text into styled badges. */
  answerSegments(text: string): { text: string; cite: boolean }[] {
    const parts: { text: string; cite: boolean }[] = [];
    const re = /\[[^\]]+\]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push({ text: text.slice(last, m.index), cite: false });
      parts.push({ text: m[0], cite: true });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last), cite: false });
    return parts;
  }

  shortSop(sop: string): string {
    return sop.replace(/^demo:/, '').replace(/\.xlsx$/, '');
  }

  example(q: string): void {
    this.input = q;
    this.send();
  }
}
