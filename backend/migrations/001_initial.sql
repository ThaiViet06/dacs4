CREATE SCHEMA IF NOT EXISTS drawing;
REVOKE ALL ON SCHEMA drawing FROM PUBLIC;

CREATE TABLE drawing.rooms (
  id uuid PRIMARY KEY,
  title varchar(100) NOT NULL,
  owner_id text NOT NULL,
  invite_hash text NOT NULL UNIQUE,
  initial_document jsonb NOT NULL,
  sequence integer NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  checkpoint jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE drawing.room_members (
  room_id uuid NOT NULL REFERENCES drawing.rooms(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX room_members_user_idx ON drawing.room_members(user_id);
CREATE TABLE drawing.room_operations (
  room_id uuid NOT NULL REFERENCES drawing.rooms(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  author_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, operation_id),
  UNIQUE (room_id, sequence)
);
CREATE TABLE drawing.saved_drawings (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  title varchar(100) NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_drawings_owner_idx ON drawing.saved_drawings(owner_id, created_at);

-- Defense in depth: this schema is never added to Supabase's exposed schemas.
-- Backend database credentials own/access these tables; browsers use Express only.
ALTER TABLE drawing.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE drawing.room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE drawing.room_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE drawing.saved_drawings ENABLE ROW LEVEL SECURITY;
