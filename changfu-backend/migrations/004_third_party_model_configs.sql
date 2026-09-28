BEGIN;

CREATE TABLE IF NOT EXISTS changfu.third_party_model_configs (
  config_id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.cloud_users(id) ON DELETE CASCADE,
  display_name varchar(80) NOT NULL,
  protocol varchar(32) NOT NULL
    CHECK (protocol IN ('OPENAI_RESPONSES', 'OPENAI_CHAT_COMPLETIONS')),
  endpoint varchar(2048) NOT NULL,
  model varchar(200) NOT NULL,
  api_key_ciphertext bytea NOT NULL,
  api_key_nonce bytea NOT NULL,
  api_key_auth_tag bytea NOT NULL,
  api_key_last_four varchar(4) NOT NULL,
  key_version smallint NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id),
  CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
  CHECK (length(trim(endpoint)) BETWEEN 1 AND 2048),
  CHECK (length(trim(model)) BETWEEN 1 AND 200),
  CHECK (octet_length(api_key_ciphertext) BETWEEN 8 AND 8192),
  CHECK (octet_length(api_key_nonce) = 12),
  CHECK (octet_length(api_key_auth_tag) = 16),
  CHECK (length(api_key_last_four) = 4)
);

REVOKE ALL ON changfu.third_party_model_configs FROM PUBLIC;

COMMIT;
