-- ---------------------------------------------------------------------------
-- Phase-2 (cont.): streaming-replication bootstrap for the PRIMARY (role part).
--
-- Mounted into /docker-entrypoint-initdb.d/ on the `postgres` (primary) service.
-- IMPORTANT: initdb scripts run ONLY on the FIRST initialization of an EMPTY
-- data volume. If the primary's volume already exists, this will NOT re-run —
-- create the role manually in that case:
--   docker compose exec postgres psql -U plutoman_owner -d plutoman \
--     -c "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator_password';"
--
-- This creates a dedicated least-privilege REPLICATION login role used by the
-- `postgres-replica` service for pg_basebackup + streaming. It is NOT the app
-- role and NOT the owner — its only extra privilege is REPLICATION.
--
-- The pg_hba.conf rule that PERMITS this role to open replication connections is
-- added by the companion init-replication.sh (SQL cannot edit pg_hba). Both run
-- during first init. This is best-effort local infra; see README Phase 2.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'replicator') THEN
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator_password';
  END IF;
END
$$;
