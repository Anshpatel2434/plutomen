/**
 * Conversation store — multi-turn chat memory for the /chat endpoint.
 *
 * Every function here is tenant-scoped: writes go through withTenant() (primary)
 * and reads through withTenantRead() (replica), so Row-Level Security scopes each
 * statement to the caller's tenant exactly like the rest of the app. The
 * tenantId passed in is ALWAYS the trusted value from the verified JWT
 * (req.auth.tenantId) — never anything from the request body.
 *
 * Cross-tenant safety: because RLS filters on app.tenant_id, a conversationId
 * that belongs to another tenant simply returns no rows for this tenant. Callers
 * treat that as "not found" (and create a fresh conversation) rather than
 * leaking or erroring across tenants — see conversationExists() /
 * getRecentMessages().
 */
import { withTenant, withTenantRead } from "./db";
import { Citation } from "./retrieval/generate";

export type ChatRole = "user" | "assistant";

/** A single turn as fed to condensing/generation (role + content only). */
export interface HistoryTurn {
  role: ChatRole;
  content: string;
}

/**
 * Create a new conversation for this tenant/user and return its id.
 * Write -> primary via withTenant().
 */
export async function createConversation(
  tenantId: string,
  userId: string,
  title?: string
): Promise<{ id: string }> {
  return withTenant(tenantId, async (client) => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, user_id, title)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [tenantId, userId, title ?? null]
    );
    return { id: res.rows[0].id };
  });
}

/**
 * Append a message to a conversation and bump the conversation's updated_at.
 * Both statements run in the same tenant-scoped transaction (primary).
 *
 * The conversations UPDATE is a no-op (0 rows) if the conversation does not
 * belong to this tenant — RLS makes cross-tenant writes impossible.
 */
export async function appendMessage(
  tenantId: string,
  conversationId: string,
  role: ChatRole,
  content: string,
  citations?: Citation[]
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO messages (tenant_id, conversation_id, role, content, citations)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        tenantId,
        conversationId,
        role,
        content,
        citations ? JSON.stringify(citations) : null,
      ]
    );
    // Bump updated_at so recency ordering / listing reflects the latest turn.
    await client.query(
      `UPDATE conversations SET updated_at = now() WHERE id = $1`,
      [conversationId]
    );
  });
}

/**
 * Return the last `limit` messages of a conversation in CHRONOLOGICAL order
 * (oldest first), as {role, content}. Read -> replica via withTenantRead().
 *
 * We select the newest `limit` rows (ORDER BY created_at DESC) then re-sort them
 * ascending, so the caller gets the tail of the conversation in reading order.
 * Returns [] when the conversation is empty or not visible to this tenant.
 */
export async function getRecentMessages(
  tenantId: string,
  conversationId: string,
  limit: number
): Promise<HistoryTurn[]> {
  return withTenantRead(tenantId, async (client) => {
    const res = await client.query<{ role: ChatRole; content: string }>(
      `SELECT role, content
       FROM (
         SELECT role, content, created_at
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT $2
       ) recent
       ORDER BY created_at ASC`,
      [conversationId, limit]
    );
    return res.rows.map((r) => ({ role: r.role, content: r.content }));
  });
}

/**
 * Does `conversationId` exist FOR THIS TENANT? RLS scopes the lookup, so a
 * conversation owned by another tenant returns false (never leaks). Read path.
 */
export async function conversationExists(
  tenantId: string,
  conversationId: string
): Promise<boolean> {
  return withTenantRead(tenantId, async (client) => {
    const res = await client.query(
      `SELECT 1 FROM conversations WHERE id = $1 LIMIT 1`,
      [conversationId]
    );
    return (res.rowCount ?? 0) > 0;
  });
}
