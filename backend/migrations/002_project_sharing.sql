-- Phòng cũ giữ quyền chia sẻ và link hiện có; version 0 dành cho link theo cơ chế cũ.
ALTER TABLE drawing.rooms
  ADD COLUMN sharing_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN sharing_version integer NOT NULL DEFAULT 0 CHECK (sharing_version >= 0);

-- Sau khi backfill dữ liệu cũ, dự án được tạo mới mặc định là Cá nhân.
ALTER TABLE drawing.rooms ALTER COLUMN sharing_enabled SET DEFAULT false;
