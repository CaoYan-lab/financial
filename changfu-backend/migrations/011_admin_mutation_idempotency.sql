BEGIN;

CREATE TABLE IF NOT EXISTS changfu_admin.mutation_idempotency_keys (
  admin_user_id uuid NOT NULL
    REFERENCES changfu_admin.admin_users(admin_user_id) ON DELETE CASCADE,
  operation varchar(240) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (admin_user_id, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS changfu_admin_mutation_keys_created_idx
  ON changfu_admin.mutation_idempotency_keys (created_at);

REVOKE ALL ON TABLE changfu_admin.mutation_idempotency_keys FROM PUBLIC;

COMMIT;
