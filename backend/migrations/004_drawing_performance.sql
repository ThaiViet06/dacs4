-- Bộ đếm gắn với sequence để tự nhận biết lúc backend cũ đã ghi thêm dữ liệu.
ALTER TABLE drawing.rooms
  ADD COLUMN document_bytes integer,
  ADD COLUMN document_bytes_sequence integer,
  ADD COLUMN render_epoch integer NOT NULL DEFAULT 0;

ALTER TABLE drawing.room_operations
  ALTER COLUMN payload DROP NOT NULL,
  ADD COLUMN packed bytea,
  ADD CONSTRAINT operation_has_one_format CHECK (
    (payload IS NOT NULL AND packed IS NULL) OR
    (payload IS NULL AND octet_length(packed) BETWEEN 17 AND 12303 AND packed IS NOT NULL)
  );

CREATE TABLE drawing.room_render_snapshots (
  room_id uuid PRIMARY KEY REFERENCES drawing.rooms(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  renderer_version integer NOT NULL,
  visible_count integer NOT NULL CHECK (visible_count >= 0),
  png bytea NOT NULL CHECK (octet_length(png) BETWEEN 1 AND 524288)
);
ALTER TABLE drawing.room_render_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drawing.room_render_snapshots FROM PUBLIC, anon, authenticated;

-- Mỗi lời gọi là một transaction. Các lỗi nghiệp vụ không chiếm số thứ tự của nét hợp lệ.
CREATE FUNCTION drawing.write_operation_batch(project_id uuid, jobs jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, drawing AS $$
DECLARE
  project drawing.rooms%ROWTYPE;
  existing drawing.room_operations%ROWTYPE;
  job jsonb;
  output jsonb := '[]'::jsonb;
  stroke_id uuid;
  author text;
  target_id uuid;
  target_sequence integer;
  next_bytes integer;
  initial_count integer;
  old_sequence integer;
  failure text;
BEGIN
  IF jsonb_array_length(jobs) NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'Invalid operation batch';
  END IF;
  SELECT * INTO project FROM drawing.rooms WHERE id = project_id FOR UPDATE;
  old_sequence := project.sequence;
  initial_count := jsonb_array_length(project.initial_document->'operations');
  FOR job IN SELECT value FROM jsonb_array_elements(jobs) LOOP
    stroke_id := (job->>'id')::uuid;
    author := job->>'author';
    target_id := (job->>'target')::uuid;
    failure := NULL;
    IF project.id IS NULL OR (NOT project.sharing_enabled AND project.owner_id <> author)
      OR NOT EXISTS (SELECT 1 FROM drawing.room_members m WHERE m.room_id = project_id AND m.user_id = author) THEN
      failure := 'ROOM_NOT_FOUND';
    ELSIF target_id IS NOT NULL AND project.owner_id <> author THEN
      failure := 'OWNER_REQUIRED';
    ELSE
      SELECT o.* INTO existing FROM drawing.room_operations o WHERE o.room_id = project_id AND o.operation_id = stroke_id;
      IF FOUND THEN
        IF existing.author_id = author THEN
          output := output || jsonb_build_array(jsonb_build_object('sequence', existing.sequence,
            'payload', existing.payload, 'packed', encode(existing.packed, 'base64'), 'duplicate', true));
          CONTINUE;
        END IF;
        failure := 'OPERATION_CONFLICT';
      ELSIF target_id IS NOT NULL AND project.sharing_enabled THEN
        failure := 'PERSONAL_MODE_REQUIRED';
      ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(project.initial_document->'operations') e
        WHERE lower(e->>'id') = stroke_id::text) THEN
        failure := 'OPERATION_CONFLICT';
      ELSIF target_id IS NOT NULL THEN
        SELECT o.sequence INTO target_sequence FROM drawing.room_operations o
        WHERE o.room_id = project_id AND o.operation_id = target_id
          AND (o.packed IS NOT NULL OR o.payload->>'type' <> 'visibility');
        IF NOT FOUND THEN
          IF EXISTS (SELECT 1 FROM jsonb_array_elements(project.initial_document->'operations') e
            WHERE lower(e->>'id') = target_id::text AND e->>'type' <> 'visibility') THEN
            target_sequence := 0;
          ELSE
            failure := 'INVALID_INPUT';
          END IF;
        END IF;
      END IF;
    END IF;
    IF failure IS NOT NULL THEN
      output := output || jsonb_build_array(jsonb_build_object('error', failure));
      CONTINUE;
    END IF;
    IF project.document_bytes IS NULL OR project.document_bytes_sequence IS DISTINCT FROM old_sequence THEN
      RETURN jsonb_build_object('stale', true, 'author', author);
    END IF;
    next_bytes := project.document_bytes + (job->>'bytes')::integer
      + CASE WHEN project.sequence + initial_count > 0 THEN 1 ELSE 0 END;
    IF next_bytes > 5242880 THEN
      output := output || jsonb_build_array(jsonb_build_object('error', 'DOCUMENT_FULL'));
      CONTINUE;
    END IF;
    project.sequence := project.sequence + 1;
    project.document_bytes := next_bytes;
    INSERT INTO drawing.room_operations(room_id, operation_id, sequence, author_id, payload, packed)
      VALUES(project_id, stroke_id, project.sequence, author, NULLIF(job->'payload', 'null'::jsonb), decode(job->>'packed', 'base64'));
    IF target_id IS NOT NULL THEN
      project.render_epoch := project.render_epoch + 1;
      DELETE FROM drawing.room_render_snapshots s WHERE s.room_id = project_id AND s.sequence >= target_sequence;
    END IF;
    output := output || jsonb_build_array(jsonb_build_object('sequence', project.sequence, 'duplicate', false, 'targetSequence', CASE WHEN target_id IS NOT NULL THEN target_sequence END));
  END LOOP;
  IF project.sequence <> old_sequence THEN
    UPDATE drawing.rooms SET sequence = project.sequence, document_bytes = project.document_bytes,
      document_bytes_sequence = project.sequence, render_epoch = project.render_epoch, updated_at = now() WHERE id = project_id;
  END IF;
  RETURN jsonb_build_object('results', output);
END;
$$;
REVOKE EXECUTE ON FUNCTION drawing.write_operation_batch(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- Chat dùng cùng khóa dự án với các thao tác đổi quyền và chỉ trả bản ghi mã hóa.
CREATE FUNCTION drawing.write_chat_message(project_id uuid, author text, message_id uuid, encrypted text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, drawing AS $$
DECLARE
  project drawing.rooms%ROWTYPE;
  saved drawing.room_messages%ROWTYPE;
  next_sequence integer;
BEGIN
  SELECT * INTO project FROM drawing.rooms WHERE id = project_id FOR UPDATE;
  IF NOT FOUND OR (NOT project.sharing_enabled AND project.owner_id <> author)
    OR NOT EXISTS (SELECT 1 FROM drawing.room_members m WHERE m.room_id = project_id AND m.user_id = author) THEN
    RETURN jsonb_build_object('error', 'ROOM_NOT_FOUND');
  END IF;
  IF NOT project.sharing_enabled THEN RETURN jsonb_build_object('error', 'SHARING_DISABLED'); END IF;
  SELECT * INTO saved FROM drawing.room_messages m WHERE m.room_id = project_id AND m.id = message_id;
  IF FOUND THEN
    IF saved.author_id <> author THEN RETURN jsonb_build_object('error', 'MESSAGE_CONFLICT'); END IF;
    RETURN jsonb_build_object('message', to_jsonb(saved), 'duplicate', true);
  END IF;
  SELECT COALESCE(MAX(m.sequence), 0) + 1 INTO next_sequence FROM drawing.room_messages m WHERE m.room_id = project_id;
  INSERT INTO drawing.room_messages(room_id, id, sequence, author_id, ciphertext)
    VALUES(project_id, message_id, next_sequence, author, encrypted) RETURNING * INTO saved;
  RETURN jsonb_build_object('message', to_jsonb(saved), 'duplicate', false);
END;
$$;
REVOKE EXECUTE ON FUNCTION drawing.write_chat_message(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
