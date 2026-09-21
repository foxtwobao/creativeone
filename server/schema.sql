CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY, issuer text NOT NULL, subject text NOT NULL,
    email text NOT NULL, email_verified boolean NOT NULL, username text NOT NULL,
    display_name text NOT NULL, avatar_url text NOT NULL DEFAULT '',
    UNIQUE (issuer, subject)
);
CREATE TABLE IF NOT EXISTS sessions (
    id_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
    csrf text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS login_flows (
    id_hash text PRIMARY KEY, state text NOT NULL, nonce text NOT NULL,
    verifier text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
    id uuid PRIMARY KEY, name text NOT NULL, capability text NOT NULL
        CHECK (capability IN ('image','text','video','audio')),
    group_id integer NOT NULL CHECK (group_id > 0), models jsonb NOT NULL,
    enabled boolean NOT NULL DEFAULT true, is_default boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS channels_default ON channels(capability) WHERE is_default AND enabled;
CREATE TABLE IF NOT EXISTS key_bindings (
    user_id uuid NOT NULL REFERENCES users(id), group_id integer NOT NULL,
    tokenone_user_id text NOT NULL, key_id text NOT NULL,
    PRIMARY KEY (user_id, group_id)
);
CREATE TABLE IF NOT EXISTS documents (
    user_id uuid NOT NULL REFERENCES users(id), namespace text NOT NULL, key text NOT NULL,
    value jsonb, revision integer NOT NULL DEFAULT 1, deleted boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, namespace, key)
);
CREATE TABLE IF NOT EXISTS files (
    user_id uuid NOT NULL REFERENCES users(id), namespace text NOT NULL, key text NOT NULL,
    disk_id uuid NOT NULL UNIQUE, mime_type text NOT NULL, bytes bigint NOT NULL,
    digest text NOT NULL, delete_requested boolean NOT NULL DEFAULT false,
    PRIMARY KEY (user_id, namespace, key)
);
CREATE TABLE IF NOT EXISTS generation_tasks (
    id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), channel_id uuid NOT NULL,
    group_id integer NOT NULL, model text NOT NULL, capability text NOT NULL, path text NOT NULL,
    status text NOT NULL, upstream_id text, result jsonb, error text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS generation_tasks_owner ON generation_tasks(user_id, created_at DESC);
