-- Lịch sử chat có thứ tự riêng, không thay đổi sequence hoặc nội dung nét vẽ.
CREATE TABLE drawing.room_messages (
  id uuid NOT NULL,
  room_id uuid NOT NULL REFERENCES drawing.rooms(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  author_id text NOT NULL,
  ciphertext text NOT NULL CHECK (ciphertext LIKE 'v1.%' AND length(ciphertext) BETWEEN 43 AND 6000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, id),
  UNIQUE (room_id, sequence)
);

-- Browser chỉ truy cập qua backend; không thêm schema drawing vào Supabase Data API.
ALTER TABLE drawing.room_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drawing.room_messages FROM PUBLIC, anon, authenticated;
