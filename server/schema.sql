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
    models jsonb NOT NULL,
    enabled boolean NOT NULL DEFAULT true, is_default boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS channels_capability ON channels(capability);
ALTER TABLE channels ADD COLUMN IF NOT EXISTS image_types jsonb NOT NULL DEFAULT '{}';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS video_types jsonb NOT NULL DEFAULT '{}';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS model_descriptions jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS key_bindings (
    user_id uuid NOT NULL REFERENCES users(id), group_id text NOT NULL,
    tokenone_user_id text NOT NULL, key_id text NOT NULL,
    PRIMARY KEY (user_id, group_id)
);
CREATE TABLE IF NOT EXISTS documents (
    user_id uuid NOT NULL REFERENCES users(id), namespace text NOT NULL, key text NOT NULL,
    value jsonb, revision integer NOT NULL DEFAULT 1, deleted boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, namespace, key)
);
CREATE TABLE IF NOT EXISTS canvas_projects (
    id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL,
    nodes jsonb NOT NULL DEFAULT '[]', connections jsonb NOT NULL DEFAULT '[]',
    chat_sessions jsonb NOT NULL DEFAULT '[]', active_chat_id text,
    background_mode text NOT NULL DEFAULT 'lines' CHECK (background_mode IN ('lines','dots','blank')),
    show_image_info boolean NOT NULL DEFAULT false,
    viewport jsonb NOT NULL DEFAULT '{"x":0,"y":0,"k":1}',
    content_revision bigint NOT NULL DEFAULT 1,
    generation_revision bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS canvas_projects_owner ON canvas_projects(user_id, updated_at DESC) WHERE deleted_at IS NULL;
ALTER TABLE canvas_projects ADD COLUMN IF NOT EXISTS generation_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS canvas_project_commands (
    project_id uuid NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
    operation_id text NOT NULL,
    base_revision bigint NOT NULL,
    base_generation_revision bigint NOT NULL DEFAULT 0,
    command jsonb NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, operation_id)
);
ALTER TABLE canvas_project_commands ADD COLUMN IF NOT EXISTS base_generation_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS files (
    user_id uuid NOT NULL REFERENCES users(id), namespace text NOT NULL, key text NOT NULL,
    disk_id uuid NOT NULL UNIQUE, mime_type text NOT NULL, bytes bigint NOT NULL,
    digest text NOT NULL, delete_requested boolean NOT NULL DEFAULT false,
    PRIMARY KEY (user_id, namespace, key)
);
CREATE TABLE IF NOT EXISTS generation_tasks (
    id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), channel_id uuid NOT NULL,
    group_id text NOT NULL, model text NOT NULL, capability text NOT NULL, path text NOT NULL,
    status text NOT NULL, upstream_id text, result jsonb, error text,
    canvas_project_id uuid REFERENCES canvas_projects(id) ON DELETE SET NULL,
    canvas_node_id text, canvas_output_index integer,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS generation_tasks_owner ON generation_tasks(user_id, created_at DESC);
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS hidden_from_works boolean NOT NULL DEFAULT false;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS canvas_project_id uuid REFERENCES canvas_projects(id) ON DELETE SET NULL;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS canvas_node_id text;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS canvas_output_index integer;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS canvas_generation_id text;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS canvas_output_id text;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS canvas_attached boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS generation_tasks_canvas_operation ON generation_tasks(user_id,canvas_project_id,canvas_generation_id) WHERE canvas_generation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS generation_tasks_canvas ON generation_tasks(canvas_project_id, canvas_node_id);

-- v2 delegates group selection to Enhance; retain task and binding IDs without numeric conversion.
ALTER TABLE channels DROP COLUMN IF EXISTS group_id;
ALTER TABLE key_bindings ALTER COLUMN group_id TYPE text USING group_id::text;
ALTER TABLE generation_tasks ALTER COLUMN group_id TYPE text USING group_id::text;

-- Preserve old Enhance bindings and tasks in a separate namespace when upgrading.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='key_bindings' AND column_name='provider') THEN
        ALTER TABLE key_bindings ADD COLUMN provider text NOT NULL DEFAULT 'legacy-enhance';
        ALTER TABLE key_bindings ALTER COLUMN provider DROP DEFAULT;
        ALTER TABLE key_bindings DROP CONSTRAINT key_bindings_pkey;
        ALTER TABLE key_bindings ADD PRIMARY KEY (user_id, provider, group_id);
    END IF;
END $$;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'legacy-enhance';
ALTER TABLE generation_tasks ALTER COLUMN provider DROP DEFAULT;

-- Authorization secrets and editor recovery stay bound to the original login session.
CREATE TABLE IF NOT EXISTS reseller_authorizations (
    session_hash text PRIMARY KEY REFERENCES sessions(id_hash) ON DELETE CASCADE,
    state_hash text NOT NULL, verifier text, issuer text NOT NULL, subject text NOT NULL,
    provider text NOT NULL, credential_hash text NOT NULL, authorization_url text,
    return_to text NOT NULL, draft jsonb, expires_at timestamptz NOT NULL,
    consumed boolean NOT NULL DEFAULT false, result text
);

ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS request jsonb;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS hidden_from_history boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS prompt_caches (
    user_id uuid NOT NULL REFERENCES users(id), source_id text NOT NULL,
    source_url text NOT NULL, last_attempt_at timestamptz NOT NULL DEFAULT now(), items jsonb NOT NULL DEFAULT '[]',
    last_success_at timestamptz, last_error text NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, source_id)
);

ALTER TABLE prompt_caches ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS execution_token uuid;

ALTER TABLE canvas_project_commands ADD COLUMN IF NOT EXISTS inverse jsonb;
ALTER TABLE canvas_project_commands ADD COLUMN IF NOT EXISTS undone boolean NOT NULL DEFAULT false;

ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS upstream_result jsonb;
