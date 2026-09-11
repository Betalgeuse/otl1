BEGIN;

CREATE TABLE otl.memberships (
  workspace_id text NOT NULL CHECK (length(btrim(workspace_id)) > 0),
  user_id text NOT NULL CHECK (length(btrim(user_id)) > 0),
  invited_by text,
  joined_at timestamptz NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id, invited_by)
    REFERENCES otl.memberships (workspace_id, user_id),
  CHECK (invited_by IS NULL OR invited_by <> user_id)
);

CREATE TABLE otl.invites (
  workspace_id text NOT NULL,
  inviter_id text NOT NULL,
  issued_month date NOT NULL CHECK (extract(day FROM issued_month) = 1),
  email_hash text NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  accepted_by text,
  accepted_at timestamptz,
  PRIMARY KEY (workspace_id, inviter_id, issued_month),
  FOREIGN KEY (workspace_id, inviter_id)
    REFERENCES otl.memberships (workspace_id, user_id),
  FOREIGN KEY (workspace_id, accepted_by)
    REFERENCES otl.memberships (workspace_id, user_id),
  CHECK ((accepted_by IS NULL) = (accepted_at IS NULL)),
  CHECK (accepted_by IS NULL OR accepted_by <> inviter_id)
);

CREATE UNIQUE INDEX invites_accepted_email
  ON otl.invites (workspace_id, email_hash) WHERE accepted_at IS NOT NULL;
CREATE UNIQUE INDEX invites_accepted_user
  ON otl.invites (workspace_id, accepted_by) WHERE accepted_at IS NOT NULL;
CREATE INDEX invites_recipient_lookup ON otl.invites (workspace_id, email_hash);

COMMIT;
