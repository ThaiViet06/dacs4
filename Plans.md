# Multi-User Online Drawing Application — Kế hoạch MVP

Cập nhật: **03/11/2026**. Tiến độ chỉ ghi nhận trong phạm vi đã kiểm chứng; các bước cần tài khoản thật tiếp tục được theo dõi riêng.

Mục tiêu: ứng dụng demo cho **2–10 người**, hoàn thiện chức năng chính ở local trước khi Docker và triển khai. Làm **mỗi lần một bước nhỏ**. `[x]` là phần đã kiểm chứng trong phạm vi ghi rõ; `[ ]` là phần còn thiếu hoặc chưa xác minh.

**Hiện tại:** Tài khoản/phòng/lời mời, cách ly phòng và vẽ chung đã được xác nhận bằng hai tài khoản thật; hai bên thấy cùng bản vẽ sau vẽ/tẩy và F5 vẫn đúng. Dữ liệu phòng đã đối chiếu Supabase chỉ đọc. Build, lint, 53 test backend và 16 test frontend đạt; tiếp theo kiểm tra mất mạng/nối lại và độ bền sau restart.

Local dùng thống nhất frontend `http://localhost:5173` và backend `http://localhost:3000`; cổng frontend khác cần cấu hình origin tương ứng ở backend.

## 1. Phạm vi chính

Giữ stack: **Vue 3 + TypeScript + Vite + Canvas**, Pinia/Vue Router; **Node.js + Express 5 + ws**; **Clerk**; **Supabase PostgreSQL qua pg ở backend**; Docker backend.

Luồng MVP cần hoàn thành:

- Đăng nhập/đăng xuất; tạo phòng, xem phòng của mình và tham gia bằng link mời khó đoán.
- Vẽ bút tự do, đường thẳng, chữ nhật, tròn; đổi màu, độ dày và dùng tẩy.
- Đồng bộ nét đã hoàn thành, tải trạng thái khi vào phòng và nối lại khi mất mạng.
- Lưu operations vào database; mỗi thành viên lưu được bản sao riêng dạng snapshot.
- Xem bản sao của mình và mở thành phòng mới, không ghi đè phòng gốc.

**Hoãn khỏi MVP:** checkpoint dùng chung riêng biệt, xem trước nét của người khác khi đang kéo, quản lý nhiều link mời, thumbnail, chat, layer, con trỏ người khác, tìm kiếm công khai, chỉnh sửa offline và undo/redo trong phòng chung. Undo/redo của Studio đã có thì giữ nguyên.

Các route/cột dữ liệu nháp cho tính năng hoãn có thể giữ lại; không xóa code hoặc sửa migration đã áp dụng chỉ để rút gọn kế hoạch.

## 2. Nguyên tắc code đơn giản và dễ đọc

- Tái sử dụng Canvas, API helper, store và repository hiện có; không thêm tầng trung gian chỉ để dự phòng tương lai.
- Tách hàm/component khi có trách nhiệm rõ ràng hoặc thực sự dùng lại; tránh chia thành nhiều file nhỏ không cần thiết.
- Chưa thêm package/framework test mới nếu công cụ hiện tại đủ dùng.
- Mỗi bước chỉ sửa phần liên quan; không refactor hoặc format toàn dự án kèm một tính năng nhỏ.
- Thêm comment tiếng Việt trước hàm mới/sửa để giải thích chức năng và quyết định khó hiểu.
- Giữ kiểm tra token, quyền phòng, dữ liệu đầu vào và lỗi lưu database; đây là yêu cầu đúng đắn của ứng dụng.
- Chỉ xóa mã thừa sau khi xác nhận không còn được sử dụng; thay đổi schema bằng migration mới, không sửa migration đã áp dụng.
- Sau mỗi bước: kiểm tra phù hợp, báo chức năng đã thay đổi và cập nhật vài dòng vào kế hoạch; không lặp lại lịch sử dài.

## 3. Các quy tắc kỹ thuật cần giữ

- Canvas logic **1600 × 900**; dựng lại từ operations, kể cả tẩy, khi resize hoặc tải lại.
- Mỗi operation có UUID. Server cấp sequence, lưu trong transaction rồi mới xác nhận/phát cho các thành viên.
- Gửi lại cùng UUID không tạo nét trùng; client vẽ lại theo sequence của server.
- Khi mất kết nối: khóa nét mới, lấy token mới, tải trạng thái rồi gửi lại nét đang chờ bằng UUID cũ. Nét chờ chỉ giữ trong bộ nhớ khi trang còn mở.
- Snapshot được tạo từ operations đã lưu qua sequence xác nhận; chỉ chủ bản sao được xem/mở. Mở snapshot tạo phòng mới.
- Giữ bốn bảng `drawing.rooms`, `room_members`, `room_operations`, `saved_drawings`; bảng `schema_migrations` theo dõi migration.
- Browser đi qua Express; backend kiểm tra thành viên/chủ sở hữu. Database dùng TLS, pool nhỏ; không đưa secrets vào `VITE_*`.
- Chủ phòng phát một link mời bằng API hiện có: link mới thay link trước, thành viên không bị xóa. Server chỉ lưu hash; sao chép dùng lại link đang hiển thị, không phát link mới.
- Một backend, tối đa 10 kết nối/phòng. Giữ giới hạn hiện có: 64 KiB/message, 2.048 điểm/operation, 5 MiB/document.
- WebSocket phải kiểm tra origin, token ban đầu, hết hạn/làm mới phiên và heartbeat. Không tự động retry yêu cầu tạo phòng vì có thể tạo trùng.

## 4. Tiến độ và các pha còn lại

### Pha 1 — Môi trường: đã làm phần cần thiết

- [x] Node 24.22.2, dependency/config, ignore secrets, build/check và backend khởi động đã được kiểm tra.
- [ ] Trước khi publish: rà Git history để tránh lộ credentials và xử lý cảnh báo dev dependency đã ghi nhận.
- Các việc môi trường còn lại tiếp tục hoãn nếu không chặn bước hiện tại; không mở rộng phần này thành một đợt refactor.

### Pha 2 — Canvas: hoàn thành

- [x] Routes, model/renderer, Pinia, tọa độ logic, DPI, resize, pointer capture/cancel đã kiểm tra.

### Pha 3 — Studio: hoàn thành phạm vi local

- [x] Năm công cụ, màu/độ dày, preview local, phím tắt, undo/redo, thông báo và xác nhận reset đã kiểm tra.
- [x] Giao diện responsive đã kiểm tra bằng trình duyệt/emulation; chưa ghi nhận kiểm thử điện thoại thật.
- Trạng thái phòng/kết nối sẽ thêm trong Pha 5, không mở rộng Studio thêm tính năng.

### Pha 4 — Tài khoản và phòng: luồng chính đạt, còn kiểm tra bổ sung

**Phụ thuộc:** Pha 2–3 và schema Supabase đã chuẩn bị ở Pha 6.

- [x] Clerk frontend, verifier/repository, health/readiness và CORS/401/403 đã được kiểm tra.
- [x] Tạo/liệt kê/mở phòng và F5 trang phòng được xác nhận thật; phòng/thành viên đầu tiên đã đối chiếu Supabase.
- [x] Chủ phòng tạo/sao chép link; tài khoản thứ hai tham gia đúng phòng, là thành viên và không có nút phát lời mời. Link không lưu vào localStorage.
- [x] Cách ly phòng được người dùng xác nhận và kiểm tra trực tiếp bằng repository/Supabase chỉ đọc: phòng chung có hai thành viên không trùng, chủ phòng giữ nguyên; phòng riêng trả 404 cho người ngoài và không hiện trong danh sách của họ.
- [ ] Kiểm tra bổ sung khi nghiệm thu Pha 4: tên rỗng/quá dài, bấm trùng khi đang gửi, phiên hết hạn, lỗi máy chủ và đổi tài khoản. Chưa kiểm tra riêng lần tải JWKS qua mạng.
- [ ] Xác nhận riêng F5 ở danh sách và cập nhật sau tạo mới bằng tài khoản thật.

**Bàn giao:** luồng đăng nhập → tạo/xem phòng → tham gia bằng lời mời.
**Đạt khi:** dùng được bằng hai tài khoản thật; người ngoài không đọc phòng và không tự nhận quyền chủ phòng.

### Pha 5 — Vẽ chung và nối lại

**Phụ thuộc:** Luồng chính Pha 4 đã đạt; các kiểm tra bổ sung tiếp tục được theo dõi.

- [x] Trang phòng nối store WebSocket sau khi API cho phép truy cập, chỉ báo đã kết nối khi nhận `room.state`; hiển thị số nét/sequence và nút thử lại. Test offline xác nhận thứ tự auth → join → state, chặn subscribe trái phép, bỏ phản hồi cũ và dọn socket/timer khi đổi phòng/đăng xuất.
- [x] Hai tài khoản thật nhận trạng thái phòng; F5 và giữ kết nối hơn một phút vẫn tốt.
- [x] Canvas có năm công cụ/màu/cỡ bút và tẩy; gửi nét khi thả con trỏ, hiển thị nét chờ. Test offline đạt cho acknowledgement, thứ tự, nét trùng, tải lại và khóa vẽ/hủy nét dở khi ngắt kết nối.
- [x] Người dùng xác nhận hai tài khoản vẽ/tẩy thấy cùng bản vẽ; chờ xác nhận nét rồi F5 vẫn tải lại đúng.
- [ ] Kiểm chứng sequence, acknowledgement và chống nét trùng trên Supabase thật, gồm tình huống mất acknowledgement.
- [ ] Người vào sau nhận đủ bản vẽ; hai client vẽ/tẩy đồng thời vẫn hội tụ cùng trạng thái.
- [ ] Nối lại với backoff, token mới và UUID cũ của nét chờ; hiển thị trạng thái kết nối và khóa vẽ khi ngắt mạng.
- [ ] Dọn kết nối khi rời phòng/đăng xuất; xử lý token hết hạn và client mất heartbeat.

**Bàn giao:** phòng vẽ chung hoạt động, có phục hồi kết nối.
**Đạt khi:** hai client thấy cùng thứ tự nét; vào muộn hoặc mất mạng/nối lại không thiếu hoặc nhân đôi nét đã xác nhận.

### Pha 6 — Lưu bản vẽ và bản sao riêng

**Phụ thuộc:** schema đã có; nghiệm thu lưu trữ đầy đủ sau Pha 5.

- [x] Kết nối Supabase qua `pg`/TLS, migration `001_initial.sql`, bốn bảng/RLS, checksum/chạy lại migration và repository readiness đã đạt.
- [ ] Kiểm chứng lưu operations/sequence và lỗi ghi trên Supabase thật; đã đạt với repository/SQL giả: chỉ phát sau COMMIT, rollback không xác nhận nét.
- [ ] Kiểm tra retry sau mất acknowledgement và khôi phục phòng sau restart backend.
- [ ] Thêm nút lưu bản sao riêng từ sequence đã xác nhận; chờ gửi xong nét trước khi lưu.
- [ ] Danh sách bản sao đơn giản gồm tên và thời gian; mở bản sao thành phòng độc lập.
- [ ] Kiểm tra quyền chủ bản sao và ghi hướng dẫn export/khôi phục dữ liệu.

**Bàn giao:** operations bền vững và luồng lưu/mở snapshot.
**Đạt khi:** restart không mất nét đã xác nhận; không lưu trùng khi retry; bản sao riêng không lộ sang tài khoản khác và không thay đổi phòng gốc.

### Pha 7 — Docker tối giản

**Phụ thuộc:** MVP local Pha 4–6 đạt và Docker Desktop/WSL2 hoạt động.

- [ ] Thêm Dockerfile và `.dockerignore` cho backend, dùng Node 24 và production dependencies.
- [ ] Chạy bằng user không phải root; cấp secrets lúc chạy.
- [ ] Kiểm tra HTTP, WebSocket, Supabase và phục hồi sau restart container.

**Đạt khi:** cùng luồng local chạy được trong một backend container; image không chứa secrets. Không cần container frontend, Kubernetes hoặc nhiều backend.

### Pha 8 — Ghép luồng và lỗi chính

**Phụ thuộc:** Pha 4–6; chạy lại với container sau Pha 7.

- [ ] Hoàn thiện luồng tài khoản → phòng → vẽ → lưu bản sao → mở lại.
- [ ] Hiển thị rõ lỗi phiên, link mời, hết chỗ, mất mạng và database; giữ trạng thái chờ khi dịch vụ đang khởi động.
- [ ] Không báo đã lưu khi còn nét chờ hoặc database chưa xác nhận.

**Đạt khi:** hai tài khoản hoàn thành toàn bộ luồng và thấy hướng xử lý khi gặp lỗi.

### Pha 9 — Kiểm thử vừa đủ

**Phụ thuộc:** thêm test cùng từng bước; tổng kiểm tra sau Pha 8.

- [x] Build/type-check/lint/format phần frontend thay đổi đạt; 16 test frontend (4 Canvas, 12 store) và 53 test backend đạt. Test mới kiểm tra nét chờ/acknowledgement, thứ tự vẽ/tẩy, nét trùng, tải lại và lỗi COMMIT bằng SQL giả. Hai kiểm tra component Canvas tạm thời đạt cho năm công cụ và hủy nét khi bị khóa; không thay thế trình duyệt/Supabase thật.
- [x] Hai tài khoản thật đã xác nhận tạo/xem/mời/tham gia, cách ly phòng, WebSocket, vẽ/tẩy đồng bộ và F5 giữ đúng bản vẽ; kết nối vẫn tốt sau hơn một phút. Backend chặn đọc phòng chưa đăng nhập bằng 401.
- [x] Đối chiếu Supabase trong transaction chỉ đọc: thành viên không trùng, đọc được phòng chung, giữ nguyên chủ; người ngoài nhận cùng lỗi 404 như phòng không tồn tại, danh sách chỉ chứa phòng đã tham gia và không lộ token/hash. Không thêm test tự động hoặc sửa dữ liệu cho bước đối chiếu này.
- [ ] Bổ sung test tập trung vào phân quyền, thứ tự nét, retry, lưu/đọc và lỗi database bằng công cụ hiện có.
- [ ] Dùng dữ liệu kiểm thử tách biệt; kiểm tra hai tài khoản, vào muộn, mất mạng và restart.
- [ ] Chạy thử tối đa 10 client; ghi độ trễ quan sát được và các giới hạn.
- [ ] Chạy build/type-check/lint và test liên quan trước nghiệm thu.

Lệnh hiện có: `npm run build` tại `frontend/`; `npm test` trong từng thư mục `frontend/` và `backend/`. PowerShell chặn `npm.ps1` thì dùng `npm.cmd`.

**Đạt khi:** luồng chính và phân quyền có bằng chứng kiểm thử. Vitest/Vue Test Utils, Playwright đầy đủ, CI và đo hiệu năng chuyên sâu là tùy chọn sau MVP.

### Pha 10 — Deploy demo

**Phụ thuộc:** kiểm thử local/container đạt và được yêu cầu triển khai.

- [ ] Giữ mục tiêu Vercel frontend, một Render Free Docker backend và Supabase; kiểm tra lại giới hạn gói trước khi deploy.
- [ ] Cấu hình HTTPS/WSS, SPA fallback, origin chính xác và Clerk cho môi trường demo.
- [ ] Thử hai thiết bị, link trực tiếp, cold start và dữ liệu sau redeploy; chuẩn bị bản export và cách chạy local dự phòng.

**Đạt khi:** demo 2–10 người dùng hoạt động và dữ liệu còn sau redeploy. Free tier có thể ngủ/tạm dừng hoặc chạm quota; không đặt yêu cầu hoạt động 24/7 cho đồ án.

### Pha 11 — Tài liệu và báo cáo

**Phụ thuộc:** cập nhật ngắn trong lúc làm; hoàn thiện sau khi có kết quả kiểm thử/demo.

- [x] Đã có hướng dẫn đóng góp, kế hoạch và comment giải thích các hàm đã triển khai.
- [ ] README đủ để chạy trên Windows: env, migration, scripts, Docker và xử lý lỗi thường gặp.
- [ ] Báo cáo ngắn về kiến trúc, ERD, thứ tự operations, retry, snapshot, kết quả kiểm thử và hạn chế.
- [ ] Chuẩn bị ảnh, slide và kịch bản demo luồng chính.

**Đạt khi:** người khác chạy lại được và nội dung báo cáo đúng với chức năng đã kiểm chứng.

## 5. Thứ tự làm tiếp

**Bước nhỏ tiếp theo ở Pha 5:** kiểm tra mất mạng/nối lại: khóa vẽ khi ngắt kết nối, tự kết nối lại và tải đủ nét của người còn lại. Sau đó kiểm tra nét chờ/chống trùng khi mất acknowledgement và phục hồi sau restart; rồi snapshot → Docker và demo. Các kiểm tra bổ sung Pha 4 vẫn giữ trong checklist.

Không đánh dấu hoàn thành chỉ vì đã có file hoặc build thành công. Chỉ chỉnh code cho bước đang làm; phần tùy chọn không chặn nghiệm thu MVP.
