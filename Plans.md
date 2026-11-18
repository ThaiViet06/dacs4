# Multi-User Online Drawing Application — Kế hoạch Studio dự án

Cập nhật: **18/11/2026**. Demo cho **2–10 người**, làm local trước Docker/deploy và **mỗi lần một bước nhỏ**. `[x]` là phần đã kiểm chứng trong phạm vi ghi rõ; `[ ]` là phần chưa hoàn thành.

**Hiện trạng:** Studio đã có menu quản lý, vẽ cộng tác và chat mã hóa. Migration 004 tối ưu đã áp dụng trên Supabase. Frontend 165 test và build/type-check đạt, backend 145 test và 1 ca Supabase tích hợp đạt.

## 1. Luồng sản phẩm đã chốt

Giữ stack: **Vue 3 + TypeScript + Vite + Canvas**, Pinia/Vue Router; **Node.js + Express 5 + ws**; **Clerk**; **Supabase PostgreSQL qua pg ở backend**; Docker backend.

Luồng chính: **Studio → Tạo/mở dự án → Vẽ tự lưu → Chia sẻ cùng chỉnh sửa trên chính dự án đó.**

- Studio có hai mục: **Cá nhân** (dự án riêng tư của bạn) và **Chung** (dự án bạn bật chia sẻ hoặc được người khác chia sẻ).
- Tạo dự án mới mặc định Cá nhân. Nhập tên trong dialog rồi mở ngay Canvas. Chủ có thể đổi tên, đổi chế độ hoặc xóa từ menu ⋮ trên thẻ.
- Editor có tên dự án, chế độ, trạng thái tự lưu, nút Chia sẻ và Về Studio; giữ công cụ/phím tắt hiện có.
- Chia sẻ yêu cầu người nhận đăng nhập Clerk, sau đó tự mở cùng bản vẽ. Chỉ chủ được đổi tên/chế độ.
- Link giữ nguyên qua các lần mở và restart. Chuyển về Cá nhân thu quyền người khác, đóng socket của họ và vô hiệu hóa link cũ; bật lại có link mới.
- Dự án Chung có chat cho thành viên: nhận tin trực tiếp, xem 50 tin gần nhất và gửi tối đa 1.000 ký tự/tin. Nội dung lưu mã hóa; backend giải mã cho người có quyền. Cá nhân đóng chat, lịch sử vẫn được giữ dưới dạng bản mã.
- Khách chưa đăng nhập vẫn được Vẽ thử bằng bản nháp local hiện có; dự án tự lưu yêu cầu đăng nhập.
- “Tạo trang giấy mới” trong editor dự án thành “Tạo dự án mới”, giữ lại dự án trước đó.

**Hoãn:** bản sao riêng, thumbnail, thư mục, layer, khách ẩn danh, quyền chỉ xem và undo/redo chung. Chat chưa cần tệp đính kèm, sửa/xóa tin, thông báo hoặc mã hóa đầu cuối.

## 2. Nguyên tắc triển khai

- Tái sử dụng Canvas, store, API helper, repository và bảng/API `rooms`; giao diện gọi là dự án, không yêu cầu tạo thêm phòng riêng.
- Giữ canvas logic 1600 × 900; UUID/sequence, transaction trước acknowledgement, retry cùng UUID không tạo nét trùng.
- Mất kết nối khóa vẽ; nối lại lấy token mới, tải trạng thái trước khi retry. Nét chờ giữ trong bộ nhớ khi trang còn mở.
- Giữ giới hạn hiện có: 10 kết nối/dự án, 64 KiB/message, 2.048 điểm/nét và 5 MiB/document.
- Browser qua backend; kiểm tra origin, token, vai trò và thành viên ở HTTP/WebSocket. TLS/pool nhỏ, secrets chỉ ở backend.
- Thay đổi schema dùng migration mới; giữ ID, nét, thành viên và dữ liệu cũ. Không sửa migration đã áp dụng.
- Code đơn giản, sửa đúng phần liên quan; comment tiếng Việt trước hàm mới/sửa. Cập nhật tiến độ ngắn sau mỗi bước đã kiểm chứng.
- Ưu tiên tự chạy kiểm thử/build với dữ liệu test riêng; ghi rõ dịch vụ/xác thực thật hay giả. Chỉ nhờ thao tác thủ công khi môi trường thiếu quyền truy cập hoặc phiên tương tác cần thiết.

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
- [x] API tạo/liệt kê/đọc có metadata `sharingEnabled`; tạo chỉ trả `{ room }`. Test quyền riêng tư/token mời đạt; người dùng xác nhận tạo/mở, tham gia và thu quyền trên UI mới bằng hai tài khoản thật.
- [x] `PATCH /api/rooms/:id` cho chủ đổi tên, trim/kiểm tra 1–100 ký tự, chỉ nhận `title` và trả metadata sau COMMIT. Test HTTP/CORS và SQL giả đạt cho quyền, đọc lại tên, giữ nguyên nét/chế độ/sequence và rollback; UI đổi tên thuộc Pha 5.
- [x] `GET /api/rooms/:id/sharing` trả `{ enabled, inviteToken? }` cho chủ, không xoay link hoặc lộ hash/version. Người dùng xác nhận copy/F5 giữ đúng link HMAC; test HTTP/repository đạt cho quyền và hai chế độ.
- [x] `PATCH /api/rooms/:id/sharing` nhận đúng `{ enabled }`, trả kết quả sau COMMIT; gửi lặp giữ link/version/thời gian. 11 test đạt cho quyền/body, link, rollback và thứ tự nét. Người dùng xác nhận bật/tắt qua UI bằng hai tài khoản thật; chưa đối chiếu SQL trực tiếp cho lần nghiệm thu này.
- [x] HMAC/helper/cấu hình đã nối từ server vào repository; bật mới lưu hash, lấy lại link HMAC qua endpoint invitation không xoay link. Khóa local đã kiểm tra hợp lệ, không ghi/in giá trị. Thiếu/sai khóa không âm thầm đổi link; chủ vẫn tắt được chia sẻ.
- [x] Restart local với cùng khóa: link HMAC khớp hash Supabase, sequence và số lượng 66 nét không đổi qua truy vấn chỉ đọc. Ngày 16/11, hai tài khoản thật xác nhận F5 giữ link/bản vẽ, dùng lại link và vẽ đồng bộ. Giữ khóa qua deploy thuộc Pha 10.
- [x] Cập nhật link cũ qua POST có xác nhận, chỉ đổi version/hash sau COMMIT. Test/Chrome giả đạt cho quyền, hủy/lỗi/retry và 390px. Người dùng xác nhận hủy rồi cập nhật bằng hai tài khoản thật: F5 giữ link/nét, thành viên vẽ tiếp không cần tham gia lại.
- [x] Đổi chế độ qua hàng đợi/transaction cùng nét/join/preview; tắt xóa thành viên khác, vô hiệu hóa link và đóng socket cộng tác 4403 sau COMMIT. Test chứng minh rollback không ngắt người đang vẽ, nét xếp trước vẫn lưu và frame xếp sau bị chặn.
- [x] Quyền backend đã test: riêng tư chỉ chủ truy cập, thành viên không đổi tên/chế độ hoặc lấy link quản lý. Hai tài khoản thật xác nhận thu quyền/link mới; ngày 17/11 xác nhận UI thành viên ẩn quản lý/undo, phím tắt không đổi hình, vẽ/F5 vẫn đúng.

**Đạt khi:** hai chế độ kiểm soát đúng HTTP/WebSocket; sao chép lại cùng link, bật/tắt không đổi ID hoặc bản vẽ.

### Pha 5 — Studio và editor thống nhất

**Nền tảng:** hai tài khoản đã xác nhận vẽ/tẩy/F5, nhận đủ nét sau Offline/Online; test có kiểm soát đạt cho nét chờ, UUID và sequence. **Bổ sung:**

- [x] Đưa danh sách/tạo dự án hiện có vào `/studio`, bỏ mục Bộ sưu tập riêng; `/gallery` chuyển về Studio. Nhãn giao diện dùng “dự án”, editor có nút Về Studio.
- [x] Lưới thẻ responsive có tên/chế độ/vai trò; bấm cả thẻ để mở. Thẻ “+” mở dialog tên, Hủy/Esc và chặn gửi trùng; Chrome với SDK/API giả đã kiểm tra tạo/lỗi/đăng xuất và 390px.
- [x] Hai mục Cá nhân/Chung lọc metadata đã tải, có ngày cập nhật và thông báo mục trống. Tải lại giữ mục đã chọn, đổi tài khoản reset bộ lọc; kiểm tra Chrome bằng dữ liệu giả đạt.
- [x] Menu ⋮ cho chủ trên thẻ dự án. Đổi tên, đổi Cá nhân/Cùng chỉnh sửa và lấy link ngay ở Studio. Xóa cần xác nhận, dọn nét vẽ/thành viên/chat sau COMMIT và đưa các tab đang mở về Studio. Chrome ở 390 px và desktop, backend với SQL giả, Supabase thật với danh tính test đã kiểm tra. Dữ liệu thử đã dọn.
- [x] Cache card/bộ lọc theo tài khoản, cập nhật ngầm và bỏ phản hồi cũ. Đổi tên/chế độ cập nhật card; thu quyền loại card ngay. 10 test store và Chrome giả đạt; F5 tải lại danh sách.
- [x] Cache editor theo dự án/tài khoản: khóa vẽ đến khi quyền/room.state hợp lệ, giữ nét chờ/rejected và link phiên. Rời trang đóng socket; mở lại đối chiếu/retry UUID cũ. Giữ tối đa năm phiên hoàn tất, không loại phiên có nét chưa lưu. Người dùng xác nhận dự án → Trang chủ → mở lại giữ nét và vẽ tiếp được; mất ACK/link/quyền kiểm chứng bằng test/Chrome giả. F5/đóng tab xóa RAM, chỉ nét đã xác nhận lưu bền.
- [x] Tạo dự án Cá nhân thành công thì mở `/studio/:id`. Ngày 04/11/2026, người dùng xác nhận đúng editor/tên, vẽ và F5 giữ nét bằng tài khoản thật. Chrome với dịch vụ giả đã kiểm tra chờ/lỗi, gửi trùng và phản hồi sau đăng xuất/rời trang.
- [x] `StudioEditor` dùng chung; `draft` giữ Vẽ thử, `board` giữ dự án và `ProjectView` kiểm tra quyền/kết nối. Điều hướng giữ bản nháp/redo; cache dự án xóa khi mất quyền/đổi tài khoản. Undo/redo Cá nhân theo Pha 6.
- [x] Chủ đổi tên qua dialog 1–100 ký tự, chặn gửi trùng; cập nhật editor/card sau xác nhận, giữ nét/sequence/bộ lọc. Người dùng xác nhận tên mới và nét giữ đúng sau mở lại/F5 bằng tài khoản thật. Test/Chrome giả đạt cho lỗi, phản hồi trễ, quyền thành viên và 390px.
- [x] Hộp Chia sẻ cho chủ ở cả hai chế độ, nối GET/PATCH, cập nhật editor/card sau xác nhận. Chặn đổi khi mất kết nối/còn nét chờ hoặc lỗi lưu; chặn gửi trùng và đóng hộp khi đang ghi. Chrome giả kiểm tra lỗi, phản hồi trễ, F5 và 390px đạt.
- [x] Chọn Cá nhân cần xác nhận thu quyền; HMAC được khôi phục/copy, tắt xóa link, bật lại có link mới. Link cũ có nút cập nhật/xác nhận, giữ URL cũ khi hủy/lỗi và chỉ hiện URL mới sau xác nhận server. Undo/redo dự án còn theo Pha 6.
- [x] Link hợp lệ tự gửi join khi Clerk sẵn sàng, bỏ nút Tham gia phòng. Chặn gửi trùng/phản hồi cũ; lỗi có Thử lại, không tự lặp. 8 test watcher và Chrome giả đạt. Ngày 16/11, người dùng xác nhận hai tài khoản thật: đăng nhập xong hoặc mở link khi đã đăng nhập đều tự vào đúng Canvas và vẽ đồng bộ. Backend vẫn kiểm tra quyền.
- [x] Nhận 4403 xóa cache/nét chờ, dừng retry, loại card và chuyển về Studio với lý do. Test/Chrome giả đạt cho phản hồi trễ/đổi tài khoản; người dùng xác nhận thành viên trở về Studio kèm thông báo khi chủ tắt chia sẻ.
- [x] Ba trang chính: `/studio` danh sách, `/studio/try` vẽ thử, `/studio/:id` dự án. `/gallery` và `/rooms/:id` chỉ chuyển hướng, giữ query/hash; test router và Chrome đạt. Danh sách/link mời sau khi tham gia mở đúng editor Studio.

**Phụ thuộc:** phần gộp giao diện đã làm trước theo ưu tiên mới, dùng giao thức hiện có. Điều khiển chia sẻ/undo tự lưu mới vẫn phụ thuộc Pha 4/6. **Đạt khi:** tạo → mở → vẽ → chia sẻ → về Cá nhân dùng được trên cùng dự án, giữ phong cách giao diện hiện tại.

### Pha 6 — Tự lưu và undo/redo cá nhân

- [x] Supabase qua pg/TLS, migration/bốn bảng/RLS/checksum và readiness đã kiểm tra.
- [x] Restart backend được xác nhận bằng hai tài khoản và truy vấn chỉ đọc: 43 nét cũ giữ nguyên, thêm một nét, sequence 44, UUID không trùng.
- [x] Tự lưu v1 ở Cá nhân/Chung: acknowledgement sau COMMIT, retry cùng UUID và khóa vẽ khi mất kết nối đã test; người dùng đã xác nhận vẽ/F5/reconnect/restart.
- [x] Bước 1: model `visibility`, chuẩn hóa v1 → v2 và hàm lấy nét đang hiện; 6 test frontend/9 backend đạt cho hình học/UUID/thứ tự/tẩy, lịch sử và giới hạn dữ liệu.
- [x] Bước 2 (repository): lưu/tải JSONB, khóa hàng/sequence, quyền chủ/Cá nhân và trả sau COMMIT; 17 test SQL giả đạt. Đã đối chiếu sự kiện trên Supabase thật qua F5/restart, chi tiết ở Pha 9.
- [x] Bước 3 (code/test): WebSocket v2 nhận commit nét/ẩn-hiện, preview chỉ có nét. Board chuẩn hóa v1/v2, giữ lịch sử đầy đủ, Canvas/nhãn chỉ lấy nét đang hiện; retry theo UUID lịch sử, lỗi quyền trả lại hình cũ. 9 test store, 1 editor và 5 WebSocket mới đạt; nghiệm thu thật ghi ở Pha 9.
- [x] Bước 4: nút và Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z cho chủ Cá nhân; stack sau ACK, khóa khi chờ/lỗi/mất mạng. F5/rời editor/đổi chế độ reset stack, reconnect giữ lịch sử phiên. 14 test store/4 UI đạt; người dùng xác nhận Ctrl+Z/Y, F5 và restart trên dự án thật, Supabase đã đối chiếu.

**Phụ thuộc:** quyền/chế độ Pha 4. **Đạt khi:** dự án cá nhân vẽ/undo/redo rồi F5 hoặc restart vẫn đúng; chuyển sang chung giữ nguyên kết quả và thứ tự.

### Pha 6.1 — Chat dự án Chung, mã hóa khi lưu

**Phụ thuộc:** Pha 4–6; tiếp tục dùng API xác thực và socket hiện có, không thêm thư viện.

- [x] AES-256-GCM, IV ngẫu nhiên, tag xác thực; bản mã ràng buộc dự án/tin/tác giả. Khóa `CHAT_ENCRYPTION_KEY` riêng ở backend; thiếu khóa không lưu nội dung rõ.
- [x] Migration `003_room_messages.sql` đã áp dụng trên Supabase, checksum khớp; bảng riêng có RLS, không cấp SELECT cho anon/authenticated. Khóa local nằm trong file Git ignore; backend tạm kiểm tra readiness/HTTP 200, chat chưa đăng nhập trả 401.
- [x] GET/POST `/api/rooms/:id/messages` kiểm tra thành viên và chế độ Chung. Thứ tự chat riêng, retry UUID không trùng; chỉ báo tin qua WebSocket sau COMMIT, xếp cùng hàng đợi với thu quyền.
- [x] Khung chat chỉ hiện khi Chung: Enter gửi, Shift+Enter xuống dòng, hỗ trợ bộ gõ; khóa gửi khi mất mạng, nối lại ghép lịch sử. Đổi tài khoản/dự án bỏ phản hồi cũ, lỗi chat không khóa vẽ.
- [x] 11 test backend và 14 test frontend mới đạt: mã hóa/giải mã, sai khóa/sửa bản mã, quyền, cách ly dự án, rollback, UUID, reconnect và mất phản hồi. Tổng 140 backend/161 frontend, build/type-check/lint đạt.
- [x] Ngày 17/11, người dùng xác nhận sau restart: hai tài khoản gửi/nhận tiếng Việt trực tiếp và F5 giữ đủ lịch sử. SQL chỉ đọc đối chiếu 2 tin/1 dự án/2 tác giả; cả 2 bản mã xác thực và giải mã đúng bằng khóa backend.
- [x] Đóng chat/thu quyền (`hi`, 17/11): người dùng xác nhận chat ẩn, thành viên về Studio và URL cũ bị chặn; sau đó đã bật lại Chung. SQL được đọc sau khi bật lại: Chung/2 thành viên, hash hai tin mã hóa không đổi. Quyền GET/POST ở Cá nhân đã có test SQL giả.

**Đạt khi:** hai thành viên trò chuyện và F5 còn lịch sử; database chỉ có bản mã nội dung, quyền chia sẻ áp dụng cho cả vẽ và chat. Giữ khóa ổn định qua restart/deploy; HTTPS/WSS được cấu hình lúc triển khai.

### Tối ưu độ trễ trước Docker

- [x] Canvas vẽ preview theo từng đoạn trên `requestAnimationFrame`. Bản chính nối nét theo sequence và dùng tối đa hai checkpoint ảnh cục bộ. Ramer–Douglas–Peucker rút bớt điểm trước commit, preview từ xa tối đa 15 Hz.
- [x] Migration 004 giữ JSONB cũ, thêm `bytea` delta/varint và batch tối đa 8 thao tác. ACK ngắn sau COMMIT, retry UUID không trùng. Chat lưu AES-GCM bằng một câu SQL.
- [x] Tạo PNG nền trong worker, đồng bộ ảnh + phần đuôi hoặc bù từ `lastSeq`. Giữ lịch sử vector cho undo/redo và khi ảnh hết hiệu lực.
- [x] Benchmark tại máy local qua Supabase thật, xác thực giả lập, hai client WebSocket và 1.000 nét có sẵn. p95 xác nhận và phát nét **12.991 → 652 ms** (16 nét), p95 gửi và phát chat **6.833 → 354 ms** (12 tin). Preview qua WS nội bộ p95 **2 → 3 ms** (16 mẫu). Dữ liệu thử đã dọn.
- [x] Hai cửa sổ Chrome qua Supabase, dự án thử 1.000 nét. Sau khi bỏ khóa ghi khỏi lượt đọc lịch sử chat, p95 preview **36 ms**, xác nhận + render nét **332 ms** (12 nét), tin hiện ở người nhận **305 ms** (10 tin). Ảnh nền 7.385 byte, JSON gốc 524.414 byte. Kiểm tra F5, 10 kết nối cùng hoạt động, 8 kết nối vẽ đồng thời và kết nối thứ 11 bị chặn.
- [x] Ca Supabase tạo/mất ACK, khởi động lại, bù sequence và retry UUID không trùng. Lỗi constraint ở thao tác thứ hai rollback cả lô, giữ sequence và cho gửi lại. Kiểm tra quyền lấy ảnh, undo vô hiệu hóa ảnh và từ chối ghi kết quả worker cũ.
- [ ] Đo lại trên bản triển khai và mạng ngoài máy local. Lượt Chrome trước khi tối ưu đọc lịch sử có một mẫu xác nhận lên 2.353 ms.

### Pha 7 — Docker tối giản

**Phụ thuộc:** luồng dự án local và kiểm thử Pha 8–9 đạt.

- [ ] Dockerfile/.dockerignore backend, Node 24, production dependencies, user không phải root và secrets runtime.
- [ ] Kiểm tra HTTP, WebSocket, Supabase và khôi phục sau restart container.

**Đạt khi:** cùng luồng local chạy trong một backend container; image không chứa secrets.

### Pha 8 — Ghép luồng và lỗi chính

**Phụ thuộc:** Pha 4–6; chạy lại sau Docker.

- [x] Người dùng nghiệm thu hai tài khoản: bật chia sẻ → copy/F5 giữ link → tham gia/vẽ → thu quyền → thành viên về Studio, link cũ bị chặn và nét của chủ giữ nguyên.
- [x] Cá nhân sau undo → Chung (`hi`, 17/11): SQL đối chiếu đúng ID và hash xác nhận initial document cùng 7 thao tác gốc không đổi (3 nét/4 sự kiện ẩn-hiện), sequence 7 và 1 nét đang hiện. Thành viên tăng từ 1 lên 2; kết quả undo giữ nguyên khi bật chia sẻ.
- [x] Nét thành viên sau undo (tự động, 17/11): dự án test riêng trên Supabase đạt sequence 7 → 8; cả hai client nhận nét mới, bảy bản ghi gốc không đổi. Server/pool test mới tải đúng lịch sử, retry UUID giữ sequence 8 và chỉ một bản ghi. Xác thực giả lập chỉ trong server test; dữ liệu đã dọn. Ca `hi` cũ giữ phạm vi đã quan sát ở mốc sequence 7.
- [x] Lỗi HTTP khi mở dự án (code/test): phân biệt mất mạng, timeout 75 giây và dịch vụ chưa sẵn sàng; giữ status khi trả HTML/JSON lỗi. UI hướng dẫn Tải lại, giữ cache khi lỗi tạm thời; không tự lặp yêu cầu ghi. 8 test API và 1 test UI mới đạt, gồm ngắt khi đọc JSON, lỗi quyền/429 và retry thủ công thành công.
- [x] Ngày 16/11, người dùng xác nhận trên trình duyệt thật: Studio → Offline → mở dự án báo đúng lỗi mạng; Online → Tải lại giữ nét và vẽ tiếp được.
- [x] Hết phiên (code/test): HTTP 401 hiện Đăng nhập lại/Tải lại; WebSocket 4401 hoặc lỗi xác thực khóa vẽ, dừng retry và giữ nét chờ trong RAM cho cùng tài khoản. SDK không có token cần đăng nhập; lỗi mạng tải token không bị coi là hết phiên. Nối lại đối chiếu trạng thái trước retry UUID cũ; đăng xuất/đổi tài khoản xóa cache. 13 test frontend mới và 31 test xác thực backend đạt.
- [x] Ngày 16/11, người dùng xác nhận trên trình duyệt thật: đăng xuất ở tab khác khóa/ẩn editor; đăng nhập lại và mở dự án giữ đúng nét đã lưu, vẽ tiếp được.
- [ ] Nghiệm thu phiên Clerk thực sự hết hạn/bị thu hồi; không suy ra từ test giả hoặc đăng xuất thủ công.
- [x] Link mời (code/test): thiếu token vẫn mở trang báo lỗi; server xác nhận link sai/vô hiệu thì hướng dẫn xin link mới, không gửi lặp. Link mới bỏ trạng thái lỗi cũ và tự tham gia; lỗi phiên có Đăng nhập lại, lỗi dịch vụ có Thử lại. HTML/404 không bị nhầm thành link vô hiệu. 11 test lời mời/test router và 27 test backend liên quan đạt.
- [x] Ngày 16/11, người dùng xác nhận cả ba bước trên trình duyệt thật: link thiếu token báo lỗi; link bị thu hồi hướng dẫn xin link mới, không có Thử lại; link mới tự mở đúng Canvas bằng tài khoản thứ hai.
- [x] Hết chỗ (code/test): 10 socket/dự án, kết nối thứ 11 không nhận trạng thái/ghi nét; hai lượt vào đồng thời chỉ lấy một chỗ cuối, tham gia lại không chiếm hai chỗ. Đóng socket giải phóng chỗ, client mới tải đủ nét rồi vẽ tiếp. 3 test backend mới dùng ws thật/SQL giả; test frontend giữ nét chờ, khóa vẽ và chỉ retry UUID sau trạng thái mới. Thông báo giải thích mỗi tab vẽ tính một kết nối và hướng dẫn Kết nối lại.
- [x] Ngày 16/11, người dùng xác nhận cả hai bước với 11 tab editor thật: tab thứ 11 báo đủ 10 kết nối và khóa vẽ; đóng một tab đã kết nối rồi Kết nối lại ở tab bị chặn khôi phục đúng bản vẽ và vẽ tiếp được.
- [x] Lỗi ghi (code/test): giữ cảnh báo theo dự án khi server chưa xác nhận; khóa vẽ/preview/chia sẻ trong lúc phục hồi. Nhận room.state chưa mở vẽ nếu nét lỗi vẫn chờ; chỉ ACK/đối chiếu UUID mới gỡ cảnh báo, lệnh bị từ chối có trạng thái chưa lưu riêng. Nét/cảnh báo qua chuyển trang giữ trong RAM cùng tài khoản; đổi tài khoản xóa cache. 5 test frontend và 1 test ws/SQL giả mới đạt, gồm nhiều nét lỗi, rollback và retry không trùng.
- [x] Ngày 16/11, người dùng xác nhận cả hai bước hồi quy sau sửa: dự án Cá nhân vẽ/tẩy → chờ đã lưu → F5 giữ hình và vẽ tiếp; nét mới → chờ → undo → chờ → F5 giữ đúng kết quả.
- [x] Ca Supabase trên dữ liệu test tách biệt: lỗi constraint rollback cả lô, retry ghi đúng sequence. Ca mất ACK sau COMMIT và gửi lại cùng UUID đã đạt.
- [x] Chờ lưu trước đổi chế độ (code/test): hộp nêu rõ đang chờ xác nhận, lỗi lưu, mất kết nối hoặc cần đăng nhập. Lựa chọn và bước xác nhận đều kiểm tra khóa hiện tại; phục hồi không tự gửi PATCH, nhãn/link chỉ đổi sau xác nhận server, giữ bản vẽ. 2 test Vue mới nối điều kiện editor với hộp chia sẻ và 16 test backend liên quan đạt.
- [x] Ngày 17/11, người dùng xác nhận hai bước trên trình duyệt thật: Offline khóa lựa chọn trong hộp Chia sẻ và nút xác nhận về Cá nhân; Online đồng bộ rồi chủ động đổi/xác nhận. F5 giữ đúng chế độ Cá nhân và bản vẽ.

**Đạt khi:** mỗi trạng thái lỗi có hướng xử lý; đổi chế độ không làm mất dữ liệu đã xác nhận.

### Pha 9 — Kiểm thử hồi quy

**Nền tảng:** frontend 165 test và backend 145 test đạt. Ca Supabase chạy riêng qua `npm run test:database`, dùng xác thực giả lập. Kết quả menu thẻ, chat, tải 10 kết nối và độ trễ local đã ghi ở các mục liên quan. Phiên Clerk tự hết hạn cần nghiệm thu riêng.

- [x] Người dùng nghiệm thu đổi tên bằng tài khoản thật: editor → Về Studio → mở lại/F5 giữ đúng tên và nét.
- [x] Người dùng nghiệm thu cập nhật link cũ: hủy rồi xác nhận, F5 giữ link mới/bản vẽ; thành viên đang mở vẫn vẽ được mà không tham gia lại.
- [x] Ngày 16/11, người dùng xác nhận link hợp lệ ở cả hai trường hợp đã/chưa đăng nhập: tự vào đúng Canvas sau xác thực, không cần bấm tham gia và vẽ đồng bộ giữa hai tài khoản.
- [x] Quyền giao diện (code/test): render template StudioEditor thật với component con giả cho thành viên, chủ Chung và chủ Cá nhân. Thành viên không có nút đổi tên/chia sẻ/undo/redo, Canvas vẫn mở vẽ; phím Ctrl+Z/Y/Shift+Z không đổi nét hoặc lịch sử nháp. Toàn bộ backend kiểm tra lại đạt, gồm quyền HTTP/WebSocket.
- [x] Ngày 17/11, người dùng xác nhận hai tài khoản thật: thành viên không có Đổi tên/Chia sẻ/Hoàn tác/Làm lại; Ctrl+Z/Y/Shift+Z giữ nguyên hình. Nét thành viên đồng bộ sang chủ, F5 cả hai giữ hình và vẽ tiếp được.
- [x] Hai nhóm (code/test): Pinia/template RoomList thật kiểm tra card Cá nhân ↔ Chung, loại card thành viên sau cập nhật danh sách, bỏ phản hồi cũ và cách ly tài khoản. API xác nhận `ROOM_NOT_FOUND` khi mở card cũ sẽ loại card khỏi cache Studio; HTML/404 không đủ để loại card. 3 test frontend mới và toàn bộ backend đạt; test chuyển chế độ/thu quyền đã có.
- [x] Ngày 17/11, người dùng xác nhận hai tài khoản thật: card chủ chuyển Cá nhân → Chung → Cá nhân; thành viên thấy card khi được mời, mở card cũ sau thu quyền bị chặn và Tải lại/F5 không còn card.
- [x] Ngày 16/11, restart backend thật và đối chiếu Supabase chỉ đọc đạt; người dùng xác nhận link giữ nguyên, bản vẽ đúng và hai tài khoản vẫn vẽ đồng bộ.
- [x] Ngày 16/11, hai tài khoản thật xác nhận tắt/bật lại: thu quyền, link mới khác link cũ, URL editor/link cũ bị chặn trước khi tham gia lại; link mới mở đúng Canvas, giữ nét và vẽ đồng bộ. Chạy lại 2 test backend và 2 frontend liên quan đều đạt.
- [ ] Người chưa tham gia thử link cũ/mới sau nâng HMAC; nâng link/F5/giữ thành viên đã xác nhận.
- [x] Ngày 16/11, hai tài khoản thật xác nhận WebSocket v2: vẽ/hình/tẩy đồng bộ, F5 giữ nét và vẽ tiếp; Offline khóa vẽ, Online tự nối lại và nhận đủ nét mới.
- [x] Ngày 16/11, dự án Cá nhân `hi`: Ctrl+Z/Y và F5 còn 1 nét; SQL chỉ đọc xác nhận v2, sequence 5, 2 nét/3 visibility. Sau restart, tự nối lại/vẽ/undo tiếp: sequence 7, 3 nét/4 visibility, vẫn hiện 1 nét; so sánh đầy đủ 5 thao tác cũ không đổi.
- [ ] Trên dữ liệu thử tách biệt: phiên hết hạn, heartbeat, đổi tài khoản và hồi quy undo local. Lỗi ghi, mất ACK, vào muộn và vẽ đồng thời đã có ca tích hợp.
- [ ] Hai tài khoản thử giao diện/bàn phím/màn hình nhỏ. Đã chạy tối đa 10 client và ghi độ trễ/giới hạn ở mục tối ưu.
- [x] Mốc 17/11: agent tự chạy 161 test frontend, 140 backend, 1 test Supabase tích hợp và frontend build/type-check, tất cả đạt. Lint/format phần nguồn sửa đã đạt ở mốc trước; tiếp tục chạy lại các kiểm tra phù hợp khi code thay đổi.

Lệnh: `npm test` trong từng app; `npm run build` tại frontend. `npm run test:database` tại backend chạy ca Supabase riêng, tạo/dọn dự án test bằng UUID/chủ giả. PowerShell dùng `npm.cmd` nếu chặn npm.ps1. Chưa cần thêm framework test.

### Pha 10 — Deploy demo

**Phụ thuộc:** Pha 7–9 đạt và được yêu cầu triển khai.

- [ ] Vercel frontend, một Render Free Docker backend và Supabase; kiểm tra giới hạn gói lúc deploy.
- [ ] HTTPS/WSS, SPA fallback, origin chính xác, Clerk và khóa chia sẻ/chat ổn định qua redeploy.
- [ ] Thử hai thiết bị, link trực tiếp, cold start/redeploy; có export dữ liệu, hướng dẫn rollback và local dự phòng.

**Đạt khi:** demo 2–10 người dùng được, link/dữ liệu giữ sau redeploy; không yêu cầu free tier chạy 24/7.

### Pha 11 — Tài liệu và báo cáo

- [x] Đã có hướng dẫn đóng góp, kế hoạch và comment giải thích code đã làm.
- [ ] Cập nhật README Windows, env, migration, scripts, chia sẻ/thu quyền, v2, Docker và xử lý lỗi.
- [ ] Kiến trúc/ERD, kết quả test, hạn chế, ảnh/slide và kịch bản demo khớp tính năng đã nghiệm thu.

## 4. Thứ tự làm tiếp

**Ưu tiên:** Pha 8–9 ghép luồng/quyền/xử lý lỗi và nghiệm thu → Docker Pha 7 → deploy/tài liệu. Kiểm thử và tài liệu tiến hành cùng từng bước.

**Bước tiếp:** chuẩn bị Docker theo thứ tự trên và đo lại hiệu năng sau triển khai. Phiên Clerk thật hết hạn/bị thu hồi theo dõi riêng. `/studio/try` chỉ là bản nháp RAM.

Snapshot bản sao riêng được xem xét sau khi luồng dự án/chia sẻ ổn định. Không đánh dấu hoàn thành vì chỉ có file hoặc build thành công; chỉ sửa và kiểm chứng bước đang làm.
