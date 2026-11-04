# Multi-User Online Drawing Application — Kế hoạch Studio dự án

Cập nhật: **04/11/2026**. Demo cho **2–10 người**, làm local trước Docker/deploy và **mỗi lần một bước nhỏ**. `[x]` là phần đã kiểm chứng trong phạm vi ghi rõ; `[ ]` là phần chưa hoàn thành.

**Hiện trạng:** Backend gần nhất 66 test đạt; frontend 50 test/build/type-check/lint đạt. Studio có cache danh sách/editor và bản nháp riêng. Người dùng đã xác nhận tạo/vẽ/F5, giữ bản nháp/redo khi qua dự án, và mở lại dự án vẫn đủ nét/vẽ tiếp được. Mất ACK, link phiên và quyền đã kiểm tra bằng dịch vụ giả. UI đổi tên, API bật/tắt chia sẻ và undo/redo dự án tự lưu còn lại.

## 1. Luồng sản phẩm đã chốt

Giữ stack: **Vue 3 + TypeScript + Vite + Canvas**, Pinia/Vue Router; **Node.js + Express 5 + ws**; **Clerk**; **Supabase PostgreSQL qua pg ở backend**; Docker backend.

Luồng chính: **Studio → Tạo/mở dự án → Vẽ tự lưu → Chia sẻ cùng chỉnh sửa trên chính dự án đó.**

- Studio có hai mục: **Cá nhân** (dự án riêng tư của bạn) và **Chung** (dự án bạn bật chia sẻ hoặc được người khác chia sẻ).
- Tạo dự án mới mặc định Cá nhân; nhập tên trong dialog rồi mở ngay Canvas. Chủ có thể đổi tên trong editor.
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

- [x] Năm công cụ, màu/cỡ bút/tẩy, preview, phím tắt, undo/redo và dialog reset. Store `draft` giữ bản nháp/lịch sử riêng; người dùng đã xác nhận vẽ hai nét → undo → qua dự án → về Vẽ thử → redo khôi phục đủ nét.
- [x] Responsive đã kiểm tra bằng trình duyệt/emulation; điện thoại thật thuộc nghiệm thu bổ sung.

### Pha 4 — Dự án và quyền chia sẻ

**Nền tảng:** Clerk, tạo/liệt kê/đọc phòng, lời mời và cách ly tài khoản đã kiểm chứng. **Bổ sung theo thứ tự:**

- [x] Migration `002_project_sharing.sql` đã áp dụng/chạy lại trên Supabase; thêm `sharing_enabled`, `sharing_version`. Mặc định mới là Cá nhân/version 0; 2 phòng cũ vẫn chung, 4 thành viên và 44 nét giữ nguyên nội dung, link và ID; checksum 001 không đổi.
- [x] API tạo/liệt kê/đọc có metadata `sharingEnabled`; tạo chỉ trả `{ room }`. Test tự động đạt cho quyền riêng tư/token mời. Người dùng đã xác nhận tạo/mở dự án Cá nhân bằng tài khoản thật; kiểm tra quyền bằng hai tài khoản trên UI mới còn chờ.
- [x] `PATCH /api/rooms/:id` cho chủ đổi tên, trim/kiểm tra 1–100 ký tự, chỉ nhận `title` và trả metadata sau COMMIT. Test HTTP/CORS và SQL giả đạt cho quyền, đọc lại tên, giữ nguyên nét/chế độ/sequence và rollback; UI đổi tên thuộc Pha 5.
- [ ] Thêm `GET/PATCH /api/rooms/:id/sharing`; PATCH nhận `{ enabled }`, bật lại cùng trạng thái không tự đổi link.
- [ ] Tạo token ổn định bằng HMAC-SHA256 của ID + sharing_version với `SHARE_LINK_SECRET` riêng, giữ khóa qua restart/deploy; database lưu hash.
- [ ] Link cũ tiếp tục dùng; chủ chủ động bấm “Cập nhật link” để chuyển sang cơ chế mới, được báo link trước sẽ hết hiệu lực.
- [ ] Đổi chế độ qua cùng hàng đợi/transaction với nét vẽ; về Cá nhân xóa quyền thành viên khác, vô hiệu hóa link và đóng socket cộng tác mã 4403.
- [ ] Dự án riêng tư chỉ chủ truy cập; tham gia bằng token chỉ được phép khi đang chia sẻ. Thành viên không đổi tên/chế độ hoặc lấy link quản lý.

**Đạt khi:** hai chế độ kiểm soát đúng HTTP/WebSocket; sao chép lại cùng link, bật/tắt không đổi ID hoặc bản vẽ.

### Pha 5 — Studio và editor thống nhất

**Nền tảng:** hai tài khoản đã xác nhận vẽ/tẩy/F5, nhận đủ nét sau Offline/Online; test có kiểm soát đạt cho nét chờ, UUID và sequence. **Bổ sung:**

- [x] Đưa danh sách/tạo dự án hiện có vào `/studio`, bỏ mục Bộ sưu tập riêng; `/gallery` chuyển về Studio. Nhãn giao diện dùng “dự án”, editor có nút Về Studio.
- [x] Lưới thẻ responsive có tên/chế độ/vai trò; bấm cả thẻ để mở. Thẻ “+” mở dialog tên, Hủy/Esc và chặn gửi trùng; Chrome với SDK/API giả đã kiểm tra tạo/lỗi/đăng xuất và 390px.
- [x] Hai mục Cá nhân/Chung lọc metadata đã tải, có ngày cập nhật và thông báo mục trống. Tải lại giữ mục đã chọn, đổi tài khoản reset bộ lọc; kiểm tra Chrome bằng dữ liệu giả đạt.
- [x] Cache danh sách/bộ lọc trong Pinia theo tài khoản: quay lại Studio hiện card ngay và cập nhật ngầm, không gửi trùng GET đang chạy. Giữ card khi lỗi dịch vụ, xóa khi lỗi xác thực/đăng xuất/đổi tài khoản kể cả ngoài Studio; bỏ phản hồi cũ, thêm thẻ vừa tạo vào cache. 7 test store và Chrome với dịch vụ giả đạt; F5 tải lại danh sách.
- [x] Cache editor theo dự án/tài khoản: khóa vẽ đến khi quyền/room.state hợp lệ, giữ nét chờ/rejected và link phiên. Rời trang đóng socket; mở lại đối chiếu/retry UUID cũ. Giữ tối đa năm phiên hoàn tất, không loại phiên có nét chưa lưu. Người dùng xác nhận dự án → Trang chủ → mở lại giữ nét và vẽ tiếp được; mất ACK/link/quyền kiểm chứng bằng test/Chrome giả. F5/đóng tab xóa RAM, chỉ nét đã xác nhận lưu bền.
- [x] Tạo dự án Cá nhân thành công thì mở `/studio/:id`. Ngày 04/11/2026, người dùng xác nhận đúng editor/tên, vẽ và F5 giữ nét bằng tài khoản thật. Chrome với dịch vụ giả đã kiểm tra chờ/lỗi, gửi trùng và phản hồi sau đăng xuất/rời trang.
- [x] `StudioEditor` dùng chung; `draft` giữ Vẽ thử, `board` giữ dự án và `ProjectView` kiểm tra quyền/kết nối. Điều hướng không xóa bản nháp/redo; cache dự án bị xóa khi mất quyền/đổi tài khoản. Undo/redo dự án vẫn chưa triển khai.
- [ ] Nối điều khiển đổi tên/chế độ vào editor; undo/redo dự án tự lưu theo Pha 6.
- [ ] Hộp Chia sẻ cho chủ chọn Cá nhân/Cùng chỉnh sửa, sao chép link; chuyển về Cá nhân dùng dialog xác nhận theo giao diện hiện có.
- [ ] Link → đăng nhập nếu cần → tự tham gia/mở đúng Canvas; thành viên thấy chế độ nhưng không có quyền quản lý.
- [ ] Hoàn thiện thu quyền chủ động qua API/chế độ: trở về Studio và báo lý do. HTTP từ chối/đổi tài khoản đã xóa cache; rời editor đóng socket/timer nhưng giữ phiên cùng tài khoản để mở lại.
- [x] Ba trang chính: `/studio` danh sách, `/studio/try` vẽ thử, `/studio/:id` dự án. `/gallery` và `/rooms/:id` chỉ chuyển hướng, giữ query/hash; test router và Chrome đạt. Danh sách/link mời sau khi tham gia mở đúng editor Studio.

**Phụ thuộc:** phần gộp giao diện đã làm trước theo ưu tiên mới, dùng giao thức hiện có. Điều khiển chia sẻ/undo tự lưu mới vẫn phụ thuộc Pha 4/6. **Đạt khi:** tạo → mở → vẽ → chia sẻ → về Cá nhân dùng được trên cùng dự án, giữ phong cách giao diện hiện tại.

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

**Nền tảng:** frontend có 50 test (4 Canvas, 26 WebSocket/cache editor, 2 nháp, 11 Studio, 7 cache danh sách), build/type-check/lint/format đạt. Chrome giả kiểm chứng khóa vẽ đến khi đồng bộ, mất ACK qua chuyển dự án, link phiên, từ chối quyền và đổi tài khoản. Backend gần nhất: 66 test; migration đã kiểm tra trên Supabase. Người dùng xác nhận tạo/vẽ/F5, giữ nháp/redo qua dự án và mở lại dự án đủ nét/vẽ tiếp được bằng tài khoản thật.

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

**Ưu tiên:** UI đổi tên dự án → hoàn thiện API chia sẻ Pha 4/tự lưu-undo-v2 Pha 6 → Pha 8–9 → Docker → deploy/tài liệu. Kiểm thử và tài liệu tiến hành cùng từng bước.

**Đã xác nhận bằng tài khoản thật:** tạo/mở/vẽ/F5, giữ nháp/redo qua dự án, và quay lại dự án tiếp tục vẽ được. **Bước nhỏ tiếp theo:** chủ đổi tên ngay trong editor bằng API đã có. Quyền/cộng tác hai tài khoản trên UI mới còn chờ; undo/redo dự án tự lưu thuộc Pha 6.

Snapshot bản sao riêng được xem xét sau khi luồng dự án/chia sẻ ổn định. Không đánh dấu hoàn thành vì chỉ có file hoặc build thành công; chỉ sửa và kiểm chứng bước đang làm.
