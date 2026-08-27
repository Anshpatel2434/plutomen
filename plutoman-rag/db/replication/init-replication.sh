#!/bin/sh
# ---------------------------------------------------------------------------
# Phase-2 (cont.): streaming-replication bootstrap for the PRIMARY (pg_hba part).
#
# Mounted into /docker-entrypoint-initdb.d/ on the `postgres` (primary) service.
# Runs ONLY on the FIRST initialization of an empty data volume (alongside
# init-replication.sql, which creates the `replicator` role).
#
# WHY THIS EXISTS: the official postgres image only appends `host all all all
# <auth>` to pg_hba.conf. The special `replication` pseudo-database is NOT
# covered by `all`, so a streaming replica cannot authenticate without an
# explicit `host replication ...` rule. We append one for the replicator role
# across the docker network and reload. Best-effort local infra only.
#
# If the primary volume already exists (this script did not run), add the rule
# manually and reload:
#   docker compose exec postgres sh -lc \
#     'echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"'
#   docker compose exec postgres psql -U plutoman_owner -d plutoman -c 'SELECT pg_reload_conf();'
# ---------------------------------------------------------------------------
set -e

RULE="host replication replicator all scram-sha-256"

if ! grep -qF "$RULE" "$PGDATA/pg_hba.conf"; then
  echo "$RULE" >> "$PGDATA/pg_hba.conf"
  echo "[init-replication] appended replication rule to pg_hba.conf"
fi

# Reload so the rule takes effect without a restart (the server is up during
# init-script execution).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "SELECT pg_reload_conf();"
