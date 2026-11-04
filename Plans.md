# Multi-User Online Drawing Application — Kế hoạch Studio dự án

Cập nhật: **04/11/2026**. Demo cho **2–10 người**, làm local trước Docker/deploy và **mỗi lần một bước nhỏ**. `[x]` là phần đã kiểm chứng trong phạm vi ghi rõ; `[ ]` là phần chưa hoàn thành.

**Hiện trạng:** Luồng phòng cũ đã chạy với hai tài khoản thật: phân quyền, vẽ/tẩy, F5, Offline/Online và restart backend. Đối chiếu Supabase sau restart giữ 43 nét cũ, thêm đúng một nét, sequence 44. Kết quả gần nhất: 55 test backend, 24 test frontend và build/type-check/lint đạt. **Mô hình Studio dự án dưới đây chưa triển khai.**

## 1. Luồng sản phẩm đã chốt

Giữ stack: **Vue 3 + TypeScript + Vite + Canvas**, Pinia/Vue Router; **Node.js + Express 5 + ws**; **Clerk**; **Supabase PostgreSQL qua pg ở backend**; Docker backend.

Luồng chính: **Studio → Tạo/mở dự án → Vẽ tự lưu → Chia sẻ cùng chỉnh sửa trên chính dự án đó.**

- Studio có hai mục: **Cá nhân** (dự án riêng tư của bạn) và **Chung** (dự án bạn bật chia sẻ hoặc được người khác chia sẻ).
- Tạo dự án mới mặc định Cá nhân, tên “Dự án chưa đặt tên”; mở ngay Canvas và cho chủ đổi tên.
- Editor có tên dự án, chế độ, trạng thái tự lưu, nút Chia sẻ và Về Studio; giữ công cụ/phím tắt hiện có.
- Chia sẻ yêu cầu người nhận đăng nhập Clerk, sau đó tự mở cùng bản vẽ. Chỉ chủ được đổi tên/chế độ.
- Link giữ nguyên qua các lần mở và restart. Chuyển về Cá nhân thu quyền người khác, đóng socket của họ và vô hiệu hóa link cũ; bật lại có link mới.
- Khách chưa đăng nhập vẫn được Vẽ thử bằng bản nháp local hiện có; dự án tự lưu yêu cầu đăng nhập.
- “Tạo trang giấy mới” trong editor dự án thành “Tạo dự án mới”, giữ lại dự án trước đó.

**Hoãn:** snapshot bản sao riêng đến sau luồng dự án/chia sẻ; tối ưu database/render, thumbnail, thư mục, chat, layer, preview từ xa, khách ẩn danh, quyền chỉ xem và undo/redo chung. Giữ code/dữ liệu hiện có của tính năng hoãn nếu còn cần tương thích.

## 2. Nguyên tắc triển khai

- Tái sử dụng Canvas, store, API helper, repository và bảng/API `rooms`; giao diện gọi là dự án, không yêu cầu tạo thêm phòng riêng.
- Giữ canvas logic 1600 × 900; UUID/sequence, transaction trước acknowledgement, retry cùng UUID không tạo nét trùng.
- Mất kết nối khóa vẽ; nối lại lấy token mới, tải trạng thái trước khi retry. Nét chờ giữ trong bộ nhớ khi trang còn mở.
- Giữ giới hạn hiện có: 10 kết nối/dự án, 64 KiB/message, 2.048 điểm/nét và 5 MiB/document.
- Browser qua backend; kiểm tra origin, token, vai trò và thành viên ở HTTP/WebSocket. TLS/pool nhỏ, secrets chỉ ở backend.
- Thay đổi schema dùng migration mới; giữ ID, nét, thành viên và dữ liệu cũ. Không sửa migration đã áp dụng.
- Code đơn giản, sửa đúng phần liên quan; comment tiếng Việt trước hàm mới/sửa. Cập nhật tiến độ ngắn sau mỗi bước đã kiểm chứng.

## 3. Các pha và checklist

### Pha 1 — Môi trường: nền tảng đã đạt

- [x] Node 24.22.2, dependency/config, ignore secrets và lệnh build/check đã kiểm tra.
- [ ] Trước publish: rà Git history và xử lý cảnh báo dev dependency đã ghi nhận.

### Pha 2 — Canvas: nền tảng đã đạt

- [x] Model/renderer, Pinia, tọa độ, DPI, resize và pointer capture/cancel đã kiểm tra.

### Pha 3 — Studio local: đã đạt

- [x] Năm công cụ, màu/cỡ bút và tẩy, preview local, phím tắt, undo/redo, phản hồi và dialog reset đã kiểm tra.
- [x] Responsive đã kiểm tra bằng trình duyệt/emulation; điện thoại thật thuộc nghiệm thu bổ sung.

### Pha 4 — Dự án và quyền chia sẻ

**Nền tảng:** Clerk, tạo/liệt kê/đọc phòng, lời mời và cách ly tài khoản đã kiểm chứng. **Bổ sung theo thứ tự:**

- [ ] Migration mới thêm `sharing_enabled`, `sharing_version`; dự án mới mặc định riêng tư. Phòng cũ thành dự án chung, giữ ID/dữ liệu/thành viên/link.
- [ ] Bổ sung metadata `sharingEnabled`; tái sử dụng API tạo/liệt kê/đọc hiện có. Tạo dự án trả metadata; link lấy qua API chia sẻ.
- [ ] Thêm `PATCH /api/rooms/:id` cho chủ đổi tên, 1–100 ký tự.
- [ ] Thêm `GET/PATCH /api/rooms/:id/sharing`; PATCH nhận `{ enabled }`, bật lại cùng trạng thái không tự đổi link.
- [ ] Tạo token ổn định bằng HMAC-SHA256 của ID + sharing_version với `SHARE_LINK_SECRET` riêng, giữ khóa qua restart/deploy; database lưu hash.
- [ ] Link cũ tiếp tục dùng; chủ chủ động bấm “Cập nhật link” để chuyển sang cơ chế mới, được báo link trước sẽ hết hiệu lực.
- [ ] Đổi chế độ qua cùng hàng đợi/transaction với nét vẽ; về Cá nhân xóa quyền thành viên khác, vô hiệu hóa link và đóng socket cộng tác mã 4403.
- [ ] Dự án riêng tư chỉ chủ truy cập; tham gia bằng token chỉ được phép khi đang chia sẻ. Thành viên không đổi tên/chế độ hoặc lấy link quản lý.

**Đạt khi:** hai chế độ kiểm soát đúng HTTP/WebSocket; sao chép lại cùng link, bật/tắt không đổi ID hoặc bản vẽ.

### Pha 5 — Studio và editor thống nhất

**Nền tảng:** hai tài khoản đã xác nhận vẽ/tẩy/F5, nhận đủ nét sau Offline/Online; test có kiểm soát đạt cho nét chờ, UUID và sequence. **Bổ sung:**

- [ ] Studio hiển thị hai nhóm Cá nhân/Chung dạng thẻ: tên, lần cập nhật, vai trò và mở dự án.
- [ ] Tạo dự án mặc định Cá nhân rồi mở editor; khóa bấm trùng và không tự retry tạo khi kết quả chưa rõ.
- [ ] Editor thống nhất dùng Canvas/thanh công cụ hiện có; có đổi tên, chế độ, trạng thái lưu và Về Studio.
- [ ] Hộp Chia sẻ cho chủ chọn Cá nhân/Cùng chỉnh sửa, sao chép link; chuyển về Cá nhân dùng dialog xác nhận theo giao diện hiện có.
- [ ] Link → đăng nhập nếu cần → tự tham gia/mở đúng Canvas; thành viên thấy chế độ nhưng không có quyền quản lý.
- [ ] Thu quyền thì dọn dữ liệu editor, trở về Studio và báo lý do; đổi tài khoản/rời editor hủy socket, timer và phản hồi trễ.
- [ ] Điều hướng: `/studio` là danh sách, `/studio/:id` là editor, `/studio/try` là vẽ thử. `/gallery` và `/rooms/:id` chuyển sang đường dẫn tương ứng; giữ hỗ trợ link mời cũ.

**Phụ thuộc:** Pha 4 và hợp đồng tự lưu/v2 ở Pha 6. **Đạt khi:** tạo → mở → vẽ → chia sẻ → về Cá nhân dùng được trên cùng dự án, giữ phong cách giao diện hiện tại.

### Pha 6 — Tự lưu và undo/redo cá nhân

- [x] Supabase qua pg/TLS, migration/bốn bảng/RLS/checksum và readiness đã kiểm tra.
- [x] Restart backend được xác nhận bằng hai tài khoản và truy vấn chỉ đọc: 43 nét cũ giữ nguyên, thêm một nét, sequence 44, UUID không trùng.
- [ ] Cả Cá nhân/Chung tự lưu qua WebSocket; chỉ báo đã lưu sau acknowledgement, giữ retry/khóa vẽ khi mất kết nối.
- [ ] Thêm sự kiện `{ id, type: 'visibility', targetId, visible }` để undo/redo cá nhân ẩn/hiện nét gốc bằng UUID/sequence; chỉ chủ ở chế độ Cá nhân được dùng.
- [ ] Giữ lịch sử sự kiện để dựng lại bản vẽ; Canvas nhận các nét đang hiển thị. Ack mất không làm gửi trùng hoặc bỏ sớm nét chờ.
- [ ] Stack undo/redo thuộc phiên mở editor; F5/đổi chế độ bắt đầu stack mới, kết quả đã xác nhận vẫn lưu bền. Tắt undo/redo khi chung hoặc còn thao tác chờ.
- [ ] Nâng document/WebSocket lên v2; chuẩn hóa dữ liệu v1 khi đọc, giữ hình học và UUID cũ. Frontend/backend cùng hỗ trợ v2 trước nghiệm thu giao diện.

**Phụ thuộc:** quyền/chế độ Pha 4. **Đạt khi:** dự án cá nhân vẽ/undo/redo rồi F5 hoặc restart vẫn đúng; chuyển sang chung giữ nguyên kết quả và thứ tự.

### Pha 7 — Docker tối giản

**Phụ thuộc:** luồng dự án local và kiểm thử Pha 8–9 đạt.

- [ ] Dockerfile/.dockerignore backend, Node 24, production dependencies, user không phải root và secrets runtime.
- [ ] Kiểm tra HTTP, WebSocket, Supabase và khôi phục sau restart container.

**Đạt khi:** cùng luồng local chạy trong một backend container; image không chứa secrets.

### Pha 8 — Ghép luồng và lỗi chính

**Phụ thuộc:** Pha 4–6; chạy lại sau Docker.

- [ ] Hai tài khoản hoàn thành tạo dự án → tự lưu → chia sẻ → cùng vẽ → thu quyền → mở lại.
- [ ] Hiển thị rõ lỗi phiên, link vô hiệu, hết chỗ, database, mất mạng và dịch vụ khởi động chậm.
- [ ] Chờ thao tác được xác nhận trước đổi chế độ; không báo đã lưu khi còn nét chờ hoặc ghi lỗi.

**Đạt khi:** mỗi trạng thái lỗi có hướng xử lý; đổi chế độ không làm mất dữ liệu đã xác nhận.

### Pha 9 — Kiểm thử hồi quy

**Nền tảng:** lần kiểm tra gần nhất có 55 test backend, 24 frontend và build/type-check/lint đạt; test SQL/token/socket giả không thay thế Supabase thật.

- [ ] Cập nhật test cho tạo mặc định riêng tư, hai nhóm dự án, đổi tên/chế độ, quyền chủ/thành viên và lỗi đầu vào.
- [ ] Kiểm tra link ổn định qua mở lại/restart, link cũ chuyển đổi đúng; tắt chia sẻ chặn HTTP/socket, bật lại cần link mới.
- [ ] Kiểm tra tự lưu/visibility/v1→v2, F5/restart, thứ tự, retry và chống trùng; hồi quy tẩy/công cụ/undo local.
- [ ] Trên dữ liệu thử tách biệt: mất acknowledgement/lỗi ghi Supabase thật, vào muộn/vẽ đồng thời, phiên hết hạn, heartbeat và đổi tài khoản.
- [ ] Hai tài khoản thử giao diện/bàn phím/màn hình nhỏ; chạy tối đa 10 client và ghi độ trễ/giới hạn.
- [ ] Chạy test trong từng app, frontend build/type-check/lint/format phần thay đổi trước nghiệm thu.

Lệnh: `npm test` trong từng thư mục app; `npm run build` tại frontend. PowerShell chặn npm.ps1 thì dùng `npm.cmd`. Chưa cần thêm framework test.

### Pha 10 — Deploy demo

**Phụ thuộc:** Pha 7–9 đạt và được yêu cầu triển khai.

- [ ] Vercel frontend, một Render Free Docker backend và Supabase; kiểm tra giới hạn gói lúc deploy.
- [ ] HTTPS/WSS, SPA fallback, origin chính xác, Clerk và khóa chia sẻ ổn định qua redeploy.
- [ ] Thử hai thiết bị, link trực tiếp, cold start/redeploy; có export dữ liệu, hướng dẫn rollback và local dự phòng.

**Đạt khi:** demo 2–10 người dùng được, link/dữ liệu giữ sau redeploy; không yêu cầu free tier chạy 24/7.

### Pha 11 — Tài liệu và báo cáo

- [x] Đã có hướng dẫn đóng góp, kế hoạch và comment giải thích code đã làm.
- [ ] Cập nhật README Windows, env, migration, scripts, chia sẻ/thu quyền, v2, Docker và xử lý lỗi.
- [ ] Kiến trúc/ERD, kết quả test, hạn chế, ảnh/slide và kịch bản demo khớp tính năng đã nghiệm thu.

## 4. Thứ tự làm tiếp

**Ưu tiên:** Pha 4 (dữ liệu/quyền/API) → Pha 6 (tự lưu/undo/v2) → Pha 5 (Studio/editor/chia sẻ) → Pha 8–9 (nghiệm thu) → Pha 7 (Docker) → Pha 10–11. Kiểm thử và tài liệu tiến hành cùng từng bước.

**Bước nhỏ đầu tiên:** bổ sung migration mới và metadata chế độ dự án; mặc định dự án mới riêng tư, giữ dữ liệu/quyền/link cũ. Sau khi kiểm chứng mới làm API quản lý chia sẻ.

Snapshot bản sao riêng được xem xét sau khi luồng dự án/chia sẻ ổn định. Không đánh dấu hoàn thành vì chỉ có file hoặc build thành công; chỉ sửa và kiểm chứng bước đang làm.
