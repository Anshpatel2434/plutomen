-- ===========================================================================
-- plutoman-rag  |  002_conversations.sql
-- ===========================================================================
-- Multi-turn conversation memory for the /chat endpoint.
--
-- Two new tenant-owned tables — `conversations` and `messages` — follow the
-- EXACT isolation pattern established in 001_init.sql: a `tenant_id` on every
-- row, Row-Level Security ENABLED + FORCED, per-operation policies filtering on
-- the per-transaction GUC `current_setting('app.tenant_id', true)`, and
-- least-privilege GRANTs to the non-owner `plutoman_app` role.
--
-- The migration runner applies db/migrations/*.sql in filename order, so this
-- (002_) runs AFTER 001_. It is idempotent (IF NOT EXISTS / DROP POLICY IF
-- EXISTS) so re-running is safe.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- conversations: one row per chat thread (a sequence of user/assistant turns)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  user_id       text,                     -- creator/owner (from the verified JWT)
  title         text,                     -- optional human-friendly label
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- messages: the individual turns within a conversation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL,
  citations       jsonb,                  -- citations attached to an assistant turn
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- Chronological fetch of a conversation's recent turns, tenant-scoped.
CREATE INDEX IF NOT EXISTS messages_tenant_conv_created_idx
  ON messages (tenant_id, conversation_id, created_at);

-- Tenant scoping helper for conversations (RLS predicate + common lookups).
CREATE INDEX IF NOT EXISTS conversations_tenant_idx
  ON conversations (tenant_id);

-- ===========================================================================
-- Row-Level Security  (same predicate + FORCE discipline as 001_init.sql)
-- ===========================================================================

-- conversations --------------------------------------------------------------
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversations_tenant_select ON conversations;
CREATE POLICY conversations_tenant_select ON conversations
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS conversations_tenant_insert ON conversations;
CREATE POLICY conversations_tenant_insert ON conversations
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS conversations_tenant_update ON conversations;
CREATE POLICY conversations_tenant_update ON conversations
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
         WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS conversations_tenant_delete ON conversations;
CREATE POLICY conversations_tenant_delete ON conversations
  FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true));

-- messages -------------------------------------------------------------------
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS messages_tenant_select ON messages;
CREATE POLICY messages_tenant_select ON messages
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS messages_tenant_insert ON messages;
CREATE POLICY messages_tenant_insert ON messages
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS messages_tenant_update ON messages;
CREATE POLICY messages_tenant_update ON messages
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
         WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS messages_tenant_delete ON messages;
CREATE POLICY messages_tenant_delete ON messages
  FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- Grants: least privilege for the app role. No DDL, no ownership.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON conversations, messages TO plutoman_app;
