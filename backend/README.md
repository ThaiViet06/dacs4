# Phát triển backend

## Phiên bản Node.js

Dự án dùng **Node 24**, tối thiểu `24.15.0`; `.nvmrc` và `.node-version` ở thư mục
gốc ghim bản `24.22.2`. Cả frontend/backend khai báo `engines.node: ^24.15.0`.
Dùng [bộ cài Node 24.22.2 chính thức](https://nodejs.org/en/download/archive/v24.22.2)
hoặc trình quản lý phiên bản đọc một trong hai file ghim. Sau khi nâng phiên bản,
mở terminal mới và chạy `node --version`, `npm --version` để kiểm tra.

## Dependency

- `pg@8.23.1`: cung cấp `Pool` để backend truy cập Supabase PostgreSQL.
- `@clerk/backend@3.26.5`: cung cấp SDK backend, gồm `verifyToken` cho xác thực phiên.

Từ `backend/`, dùng `npm ci` để khôi phục dependency theo lockfile trên máy mới.
Kiểm tra hai package mà không khởi động dịch vụ:

```powershell
npm ls pg @clerk/backend --depth=0
```

## Cấu hình môi trường

Từ thư mục dự án, mở PowerShell và tạo file local nếu chưa có:

```powershell
cd backend
if (-not (Test-Path -LiteralPath .env.local)) {
  Copy-Item -LiteralPath .env.example -Destination .env.local
}
```

Điền cấu hình thực tế vào `.env.local` theo các biến trong [`.env.example`](.env.example).
Các biến bắt buộc: `DATABASE_URL`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
`ALLOWED_ORIGINS`. Ví dụ origin frontend: `http://localhost:5173`; dùng đúng origin
đang mở trong trình duyệt, phân cách nhiều origin bằng dấu phẩy.

Thứ tự ưu tiên: **biến môi trường hệ thống → `backend/.env.local` → `backend/.env`**.
Giá trị đã có ở nguồn ưu tiên cao hơn sẽ được giữ nguyên, kể cả giá trị rỗng;
biến bắt buộc rỗng sẽ gây lỗi cấu hình. `.env` là nguồn dự phòng tùy chọn.
Đường dẫn file được tính từ module cấu hình, không phụ thuộc thư mục chạy lệnh.
Máy chủ và script migration dùng chung bộ nạp này.

Không commit `.env.local`, `.env` hoặc khóa thật. File mẫu chỉ chứa giá trị minh họa.
Khi triển khai, cấp cấu hình bằng biến môi trường runtime.

`SHARE_LINK_SECRET` là khóa riêng cho link chia sẻ: 32 byte ngẫu nhiên, ghi thành
64 ký tự hex. Cần khóa để bật chia sẻ mới hoặc lấy lại link HMAC; để trống vẫn
đọc/vẽ và tắt chia sẻ được. Cấu hình kiểm tra định dạng và không in giá trị khi sai.
Để chuẩn bị khóa, tự chạy lệnh sau rồi lưu kết quả vào `backend/.env.local`:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Giữ nguyên khóa qua restart/deploy; dùng một khóa mới sẽ tạo token khác.
Khóa này chỉ ở backend, không dùng lại khóa Clerk hoặc đưa vào biến `VITE_*`.

## Chạy và kiểm tra

Chạy bộ test backend độc lập với database từ `backend/`:

```powershell
npm test
```

Kiểm thử tích hợp PostgreSQL thật, chạy riêng khi đã cấu hình `backend/.env.local`:

```powershell
npm.cmd run test:database
```

`tests/database/collaboration.test.js` tự tạo một dự án riêng với UUID/chủ giả,
chạy API và hai client WebSocket trên cổng localhost tạm. Ca thử vẽ/undo đến
sequence 7 → bật Chung → thành viên tham gia/vẽ → sequence 8 → khởi động lại
server/pool test → tải lịch sử và retry cùng UUID. PostgreSQL là thật, xác thực
dùng hai token giả chỉ có hiệu lực trong server test. Dữ liệu ca thử được dọn
theo ID/chủ/tên riêng, kiểm tra cả bản ghi liên quan sau khi xóa.

Ngày 17/11/2026, ca này đạt trên Supabase: bảy thao tác gốc giữ nguyên, cả hai
client nhận nét mới, server/pool mới khôi phục đúng và retry không tạo nét trùng;
dữ liệu test đã dọn. Ca Supabase chạy riêng qua `test:database`; `npm test` vẫn
dùng test độc lập với dịch vụ ngoài. Các lần sửa code ưu tiên tự chạy kiểm thử và
báo rõ phạm vi thật/giả trước khi cần hỗ trợ thủ công.

`src/auth.js` tạo `verifySessionToken()` dùng chung cho API và WebSocket. SDK Clerk
xác minh chữ ký, issuer, origin và thời gian; ứng dụng kiểm tra ID người dùng,
ID phiên, hạn phiên và từ chối phiên đăng nhập còn `pending`. `server.js` kiểm tra
cấu hình xác thực trước khi tạo pool PostgreSQL.

31 test trong `tests/auth.test.js` dùng SDK thật với khóa RSA chỉ tồn tại trong bộ
nhớ và repository giả. Chúng kiểm tra token hợp lệ/sai, phản hồi HTTP an toàn và
xác thực WebSocket, tải trạng thái sau xác thực và chặn subscribe chưa đăng nhập/
chưa có quyền thành viên. Không cần khóa Clerk thật, Supabase hoặc chạy migration.

15 test bổ sung trong `tests/memory-repository.test.js` và `tests/rooms.test.js`
kiểm tra tạo/liệt kê/đọc metadata phòng, cách ly hai tài khoản, chặn giả mạo chủ
phòng, giới hạn danh sách và chống sửa dữ liệu trả về. PATCH được kiểm tra cho
quyền chủ, tên 1–100 ký tự, body/ID sai, tên mới khi đọc lại và CORS preflight.

11 test trong `tests/invitation.test.js` kiểm tra repository PostgreSQL thật với pool
SQL giả và route HTTP: quyền phát/join, hash, link cũ, tham gia lại không trùng,
không đổi chủ phòng và rollback khi lỗi ghi. Dự án Cá nhân chặn link ngay cả khi
token đúng hoặc còn thành viên cũ; chỉ chủ được đọc metadata/trạng thái.

14 test trong `tests/collaboration.test.js` dùng client `ws` thật và repository
PostgreSQL với SQL giả: xác nhận sau COMMIT, phát cùng thứ tự, chống nét trùng,
tải lại trạng thái, nhận đủ nét sau ngắt/nối lại và không xác nhận khi transaction
lỗi. Test mất acknowledgement chủ động ngắt client khi COMMIT đang chờ; retry
sau COMMIT giữ nguyên sequence, retry sau rollback lưu đúng một lần. V2 kiểm tra
ẩn/hiện qua COMMIT/reload/mất ACK, quyền Cá nhân và chặn preview sự kiện lịch sử.

Test đợt lỗi ghi giữ lại bản vẽ đã lưu, rollback hai nét mới và không phát xác
nhận cho cộng tác viên. Sau phục hồi, mỗi UUID được ghi đúng một lần; gửi trùng
trả sequence cũ. Lỗi COMMIT được điều khiển bằng SQL giả, không phải sự cố thật
trên Supabase.

Giới hạn 10 socket/dự án được kiểm tra bằng hai tài khoản giả: chặn kết nối thứ
11 và thao tác ghi của nó, hai lượt vào đồng thời tranh chỗ cuối, tham gia lại
không chiếm thêm chỗ. Đóng socket giải phóng chỗ; kết nối mới nhận đủ nét trước
khi vẽ tiếp. Các test dùng SQL giả, không đánh giá tải/độ trễ Supabase thực tế.
4 test trong `tests/rename.test.js` dùng repository PostgreSQL với SQL giả: chủ
đổi tên dự án Cá nhân/Chung, giữ nguyên nét/quyền/sequence, chặn thành viên và
rollback khi UPDATE/COMMIT lỗi. 6 test trong `tests/sharing.test.js` kiểm tra GET
trạng thái chia sẻ: quyền chủ, hai chế độ, origin/xác thực/UUID, lỗi database và
không thay dữ liệu. 6 test trong `tests/share-token.test.js` kiểm tra HMAC ổn định,
đổi UUID/version/khóa, định dạng token và cấu hình khóa an toàn. 16 test trong
`tests/sharing-toggle.test.js` dùng SQL giả/HTTP/client ws thật kiểm tra bật/tắt,
retry/link qua tạo lại repository, quyền, rollback, thu quyền socket và nâng link
cũ có xác nhận, giữ thành viên đang vẽ. 9 test trong `tests/document.test.js` kiểm
tra chuyển v1/v2, lịch sử ẩn/hiện, UUID trùng/đích sai, giới hạn hình học/5 MiB và
schema WebSocket v2. 17 test trong `tests/visibility.test.js` dùng repository
thật với SQL giả có khóa hàng/transaction: lưu/tải lịch sử, quyền chủ/Cá nhân,
retry/JSONB, sequence, rollback và đổi chế độ đồng thời. Cùng 11 test chat ở mục
bên dưới và 2 test xóa dự án, `npm test` hiện đạt **142 test backend**, dùng các fixture cục bộ.

`src/memory-repository.js` cung cấp `ready()`, `createRoom()`, `listRooms()` và
`getRoom()`, `renameRoom()`, `getSharing()`, `setSharing()`, `upgradeInvitation()` cho development/test. Chủ phòng được thêm làm thành viên đầu tiên;
dự án mới mặc định Cá nhân và danh sách tối đa 100 mục. Metadata có
`sharingEnabled`; API tạo chỉ trả `{ room }`, không trả token. Repository tạm vẫn
có token nội bộ cho fixture; giao diện lấy link qua luồng chia sẻ riêng.

Repository này được inject vào `createApplication()` trong test. Mỗi instance có
dữ liệu RAM riêng và mất dữ liệu khi dừng tiến trình; `server.js` hiện vẫn dùng
PostgreSQL. Giao diện đã nối tạo/liệt kê/đọc thông tin phòng, phát và nhận link
mời; người dùng đã xác nhận tài khoản thật thứ hai tham gia đúng phòng và có vai
trò thành viên. Cách ly phòng được xác nhận bằng hai tài khoản thật và đối chiếu
Supabase chỉ đọc: người ngoài bị từ chối, danh sách chỉ trả phòng đã tham gia,
thành viên không trùng và chủ phòng không đổi. Các kiểm tra bổ sung còn lại theo
[Plans.md](../Plans.md).

## Nền tảng tài liệu v2

`src/protocol.js` có `eventSchema()` kiểm tra nét hoặc sự kiện
`{ id, type: 'visibility', targetId, visible }`. `normalizeDocument()` đọc v1/v2,
trả bản v2 độc lập, giữ UUID/hình học/thứ tự và toàn bộ lịch sử. ID phải duy nhất;
sự kiện chỉ ẩn/hiện một nét xuất hiện trước đó, không tham chiếu sự kiện khác.
Giới hạn canvas, hình học và 5 MiB vẫn áp dụng.

`PostgresRepository.commit()` đã ghi sự kiện vào `room_operations.payload` cùng
sequence trong transaction hiện có, chỉ trả kết quả sau COMMIT. Sự kiện mới yêu
cầu chủ dự án Cá nhân; retry đúng UUID/payload trả sequence cũ, không thêm bản ghi.
JSONB được so sánh theo giá trị thay vì thứ tự khóa. Khi đã bật chia sẻ, chủ vẫn
nhận lại xác nhận của sự kiện cũ, còn sự kiện ẩn/hiện mới bị chặn.

`document()` ghép lịch sử theo sequence, giữ v1 khi chỉ có nét cũ và trả v2 khi
có ẩn/hiện; giữ cả nét gốc và các sự kiện, không xóa dữ liệu để hoàn tác.
Tải một mốc sequence chỉ lấy lịch sử đến mốc đó. Không cần migration vì payload
đã là JSONB. Đã kiểm tra bằng SQL giả và đối chiếu Supabase thật ngày 16/11/2026:
dự án `hi` sau undo/redo/F5 có sequence 5 (2 nét/3 visibility), hiện 1 nét. Người
dùng restart backend rồi vẽ/undo tiếp: sequence 7 (3 nét/4 visibility), vẫn hiện
1 nét; đối chiếu đầy đủ lịch sử qua sequence 5 không đổi. Các truy vấn kiểm tra
chỉ đọc; thao tác ghi do người dùng thực hiện qua giao diện.

WebSocket dùng v2 cho auth/join/commit/phản hồi; payload tài liệu vẫn có thể là
v1 hoặc v2. Commit nhận nét hoặc ẩn/hiện, preview chỉ nhận nét. Schema lỗi giữ
operation ID để client xử lý thao tác chờ; sự kiện lịch sử không phát preview.
Repository kiểm tra quyền và chỉ trả thành công sau COMMIT; UUID lặp chỉ xác nhận
cho người gửi. Frontend đã có store/Canvas v2 và nút/phím undo/redo cho chủ Cá
nhân, cập nhật stack sau ACK. Người dùng đã nghiệm thu F5/restart và vẽ/undo tiếp
trên dự án Cá nhân; các kiểm tra quyền/ghép luồng còn lại theo [Plans.md](../Plans.md).

Chạy backend và frontend cùng bản sau cập nhật; protocol v1 không còn được nhận,
dữ liệu v1 trong database vẫn đọc được. Local đã xác nhận health/readiness 200
và phản hồi v2 `AUTH_REQUIRED` cho socket chưa đăng nhập. Ngày 16/11/2026, hai tài
khoản thật xác nhận vẽ/hình/tẩy đồng bộ, F5 giữ nét/vẽ tiếp và Offline/Online tự
nối lại nhận đủ nét. Visibility/undo/redo/F5/restart cũng đã được nghiệm thu trên
Supabase thật; kết quả và phạm vi còn lại theo [Plans.md](../Plans.md).

## API đổi tên dự án

`PATCH /api/rooms/:id` nhận JSON `{ "title": "Tên dự án mới" }` và Bearer token
Clerk. Chỉ chủ được đổi tên; tên được trim rồi kiểm tra dài 1–100 ký tự, body chỉ
được chứa `title`. Thành công trả `200 { room }` sau COMMIT, cập nhật tên/thời gian
và giữ nguyên chủ, chế độ chia sẻ, sequence, nét vẽ, checkpoint và link.

Thành viên dự án chung nhận 403, người ngoài/phòng không tồn tại nhận cùng 404;
thiếu đăng nhập nhận 401, dữ liệu sai nhận 400, database lỗi nhận 503. CORS cho
phép PATCH từ origin tin cậy. Editor đã có nút đổi tên; người dùng xác nhận tên
editor/card và nét vẽ giữ đúng sau mở lại/F5 bằng tài khoản thật.

## API xóa dự án

`DELETE /api/rooms/:id` yêu cầu xác thực Clerk và quyền chủ dự án. Phản hồi
`200 { id }` xác nhận transaction đã COMMIT. Khóa ngoại xóa các nét vẽ, thành viên
và tin nhắn thuộc dự án. Server đóng các WebSocket của dự án với mã `4404` để
editor trở về Studio. Test SQL giả kiểm tra quyền và rollback. Ca Chrome với
danh tính test và Supabase thật đã đối chiếu việc xóa các bản ghi liên quan.

## API đọc trạng thái chia sẻ

`GET /api/rooms/:id/sharing` dùng Bearer token Clerk, chỉ dành cho chủ dự án.
Thành công trả `200 { enabled, inviteToken? }` với `Cache-Control: no-store`.
Token chỉ được trả cho chủ khi đang chia sẻ bằng HMAC, giúp khôi phục đúng link
sau F5. GET chỉ đọc, không tạo/thay link, đổi thời gian cập nhật, thành viên hoặc
nét vẽ; không trả hash/version nội bộ. Link cũ version 0 không trả token.

Thành viên dự án chung nhận 403 `OWNER_REQUIRED`; người ngoài, dự án không tồn tại
và thành viên cũ của dự án Cá nhân cùng nhận 404 `ROOM_NOT_FOUND`. Thiếu/hết phiên
nhận 401, UUID sai nhận 400, database lỗi nhận 503 thay vì giả định đang riêng tư.
Đã kiểm tra bằng HTTP với repository/SQL giả. Người dùng đã xác nhận qua giao
diện bằng hai tài khoản thật: copy/F5 giữ link, tham gia/vẽ và thu quyền thành công.

`src/sharing.js` cung cấp `createShareTokenGenerator(secret)`: dùng HMAC-SHA256
với dữ liệu `drawing-share:v1:<uuid viết thường>:<version>` và trả token base64url
43 ký tự, tương thích định dạng token join hiện có. Cùng ID/version/khóa cho cùng
token khi tạo lại bộ sinh; đổi một trong ba cho token khác. Helper kiểm tra UUID,
version nguyên không âm và khóa trước khi tạo token, không tự sinh khóa dự phòng.
Helper đã nối vào repository qua `server.js`, không đổi link cũ khi khởi động.

## API bật/tắt chia sẻ

`PATCH /api/rooms/:id/sharing` nhận đúng JSON `{ "enabled": true }` hoặc
`{ "enabled": false }`, chỉ dành cho chủ. Trả `200 { room, enabled, inviteToken? }`
sau COMMIT; hash/version nội bộ không được trả về. Gửi lại cùng trạng thái không
đổi link, version hoặc thời gian cập nhật.

Bật từ Cá nhân tăng version, tạo token HMAC và chỉ lưu hash. Chủ lấy lại đúng link
qua GET chia sẻ, PATCH bật lặp hoặc `POST /api/rooms/:id/invitation`, kể cả sau restart với cùng
khóa. Dự án cũ version 0 đang chung giữ nguyên link khi PATCH bật lặp, không trả
`inviteToken` vì token ngẫu nhiên cũ không thể khôi phục từ hash; endpoint invitation
cũ vẫn phát link ngẫu nhiên mới cho version 0 để tương thích; UI hiện dùng API nâng link có xác nhận bên dưới.

Tắt tăng version, thay hash và xóa thành viên khác trong cùng transaction. Sau
COMMIT, các socket cộng tác bị đóng mã 4403, socket chủ được giữ; nét/preview xếp
sau thao tác thu quyền bị chặn. Bật lại không khôi phục thành viên cũ, cần link mới.
ID, tên, nét, sequence và checkpoint giữ nguyên qua đổi chế độ.

Body/UUID sai trả 400; thiếu/hết phiên 401; thành viên chung 403; người ngoài hoặc
dự án thiếu cùng 404. Thiếu khóa hoặc khóa không khớp link HMAC hiện tại trả
503 `SHARING_UNAVAILABLE`, không xoay link âm thầm; chủ vẫn tắt được chia sẻ.
Lỗi UPDATE/DELETE/COMMIT rollback cả quyền/link và không ngắt socket.
Đã test với SQL giả. Người dùng xác nhận bật/tắt qua UI bằng hai tài khoản thật:
thành viên về Studio kèm thông báo, link cũ bị chặn, nét của chủ giữ nguyên.
Ngày 16/11/2026, đối chiếu chỉ đọc trước/sau restart local xác nhận link HMAC
khớp hash Supabase, sequence và số lượng 66 nét không đổi. Hai tài khoản thật
xác nhận F5 giữ link/bản vẽ, dùng lại link và vẽ đồng bộ được. Hai tài khoản cũng
nghiệm thu tắt/bật lại: link mới khác link cũ, URL editor/link cũ bị chặn trước khi
tham gia lại; link mới cho mở Canvas, giữ nét và vẽ đồng bộ. Không thay khóa chia
sẻ trong các lần kiểm tra này.

## Cập nhật link cũ sang HMAC

`POST /api/rooms/:id/sharing/upgrade` nhận đúng `{ "confirmed": true }`, chỉ dành
cho chủ dự án đang chia sẻ. Trả `200 { room, enabled: true, inviteToken }` sau
COMMIT. Version 0 được nâng lên 1 và thay hash; giữ nguyên thời gian cập nhật,
tài liệu, sequence, thành viên và socket. Gửi lặp hoặc đồng thời khi đã dùng
HMAC trả cùng token, không đổi version lần nữa.

Link cũ hết hiệu lực cho người chưa tham gia; thành viên hiện tại vẫn vẽ được.
GET chia sẻ lấy lại token mới qua F5/restart với cùng khóa. Thiếu xác nhận/body
sai nhận 400, thiếu/hết phiên 401, thành viên 403, người ngoài/phòng thiếu 404,
dự án Cá nhân 409; thiếu khóa hoặc lỗi ghi nhận 503 và giữ link cũ.
Đã kiểm tra bằng SQL giả/client ws thật và Chrome giả. Người dùng xác nhận bằng
hai tài khoản thật: hủy rồi cập nhật, F5 giữ đúng link/bản vẽ và thành viên vẫn vẽ
tiếp mà không cần tham gia lại. Link HMAC đã được xác nhận qua restart local
ngày 16/11/2026; thử link cũ/mới sau nâng cấp bằng người chưa tham gia còn chờ.
Luồng nâng link chưa được đối chiếu SQL trực tiếp trong lần nghiệm thu đó.

## Khởi tạo database

Từ `backend/`, sau khi điền cấu hình Supabase của môi trường phát triển:

```powershell
node scripts/migrate.js
```

Script áp dụng các file trong `migrations/` theo thứ tự, lưu checksum và dùng khóa
để tránh chạy song song. Migration đã áp dụng sẽ được bỏ qua; sửa nội dung file
đã áp dụng sẽ gây lỗi checksum. Thay đổi schema tiếp theo cần file migration mới.

`001_initial.sql` đã chạy thành công trên database đang cấu hình, tạo bốn bảng
`drawing.rooms`, `drawing.room_members`, `drawing.room_operations`,
`drawing.saved_drawings` có RLS và bảng theo dõi `drawing.schema_migrations`.
Checksum và chạy lại migration đã được kiểm tra. Không thêm schema `drawing`
vào danh sách schema công khai của Supabase Data API.

`002_project_sharing.sql` bổ sung `sharing_enabled` và `sharing_version`: các
phòng cũ giữ trạng thái chung/version 0 và link cũ; dự án tạo sau migration mặc
định Cá nhân. Chạy migration trước khi khởi động backend mới; readiness kiểm tra
cả hai cột. `001_initial.sql` giữ nguyên checksum.

Đã áp dụng và chạy lại ngày 04/11/2026: hai migration được ghi nhận đúng một lần,
mặc định riêng tư/version 0 và repository readiness đạt. Đối chiếu số lượng/hash
các bảng xác nhận 2 phòng, 4 thành viên, 44 nét không thay đổi; phòng cũ vẫn chung.

Chủ đọc/vẽ dự án Cá nhân và bật chia sẻ qua UI; người khác chỉ tham gia khi chia sẻ
đang bật. GET/PATCH và luồng thu quyền đã được người dùng xác nhận; chuyển link
cũ sang HMAC đã được người dùng nghiệm thu. Frontend tự gọi API join sau khi
Clerk sẵn sàng, không đổi kiểm tra token/chế độ/thành viên của backend. Ngày
16/11/2026, người dùng xác nhận bằng hai tài khoản thật: đăng nhập xong hoặc mở
link khi đã đăng nhập đều tự vào đúng Canvas và vẽ đồng bộ. Link HMAC qua restart
local và bật lại sau thu quyền đã nghiệm thu; các kiểm tra còn lại theo
[Plans.md](../Plans.md).

Chạy lệnh từ `backend/` nếu `DATABASE_CA_FILE` dùng đường dẫn tương đối. Thông tin
đăng nhập database và CA được cấp qua cấu hình hiện có; không tắt kiểm tra TLS.

Entry point là `server.js`. Sau khi hoàn tất dependency và chuẩn bị database:

```powershell
npm run dev       # Chạy bằng nodemon
npm start         # Chạy bằng Node.js
```

## Kiểm tra khôi phục sau restart

1. Mở cùng phòng bằng hai tài khoản, chờ hết nét đang chờ xác nhận.
2. Giữ hai trang mở; tại terminal backend đang chạy, nhấn Ctrl+C rồi chạy lại
   `npm.cmd run dev` từ `backend/`.
3. Không F5: hai client phải tự kết nối lại và giữ đúng bản vẽ đã lưu.
4. Vẽ thêm một nét, chờ xác nhận; tài khoản kia phải nhận được nét đó.

Đối chiếu operations/sequence trước và sau bằng truy vấn chỉ đọc. Kết quả nghiệm
thu ngày 04/11/2026 đạt: hai tài khoản tự nối lại, bản vẽ giữ nguyên và vẽ tiếp
đồng bộ; Supabase giữ đủ 43 nét cũ, lưu thêm đúng một nét, sequence 44 và UUID
không trùng. Chi tiết phạm vi còn lại theo [Plans.md](../Plans.md).

Kiểm tra cú pháp cấu hình mà không mở máy chủ hoặc kết nối database:

```powershell
node --check src/config.js
node --check server.js
```

Kiểm tra thật ngày 2026-11-02: kết nối Supabase qua `pg` với chứng chỉ TLS hợp lệ,
repository readiness, `/healthz` (200), `/readyz` (200), và API phòng chưa đăng nhập
(401 `AUTH_REQUIRED`) đều đạt. Backend dừng sạch sau kiểm tra; tiến trình thử nghiệm
không được giữ chạy. Luồng phòng HTTP bằng tài khoản thật đã được xác nhận sau đó;
hai tài khoản thật cũng đã xác nhận WebSocket nhận trạng thái, F5 và giữ kết nối
hơn một phút. Hai tài khoản thật đã xác nhận vẽ/tẩy/F5 và Offline/Online nhận đủ
nét; khôi phục sau restart cũng đã xác nhận và đối chiếu Supabase chỉ đọc.
Lần tải JWKS riêng và mất acknowledgement trên Supabase thật tiếp tục theo dõi
trong kế hoạch.

Audit ngày 2026-11-02: dependency production không có cảnh báo; audit đầy đủ còn
2 mục moderate trong chuỗi development `nodemon → minimatch` đã tồn tại trước lần
cài này. Việc xử lý được theo dõi trong [Plans.md](../Plans.md).

## Chat trong dự án Chung

Chỉ thành viên của dự án đang chia sẻ được đọc/gửi chat. `GET` và `POST` tới
`/api/rooms/:id/messages` dùng cùng Bearer token Clerk; POST nhận `{ id, text }`
(UUID và 1–1.000 ký tự), danh tính lấy từ token. GET trả 50 tin mới nhất theo thứ tự
cũ đến mới. HTTP và sự kiện WebSocket `chat.message` chỉ xác nhận sau COMMIT;
retry cùng UUID/nội dung trả lại tin cũ. Chat có sequence riêng với bản vẽ.

Nội dung được mã hóa AES-256-GCM bằng `node:crypto` trước khi ghi vào
`drawing.room_messages.ciphertext`. IV mới cho mỗi tin, tag 16 byte, AAD ràng buộc
dự án/UUID/tác giả. Backend giải mã khi trả cho thành viên; metadata tác giả và thời
gian không mã hóa. Truyền qua HTTPS/WSS khi triển khai; local hiện dùng HTTP/WS.
Tham khảo [Node.js Crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html).

Thiết lập trên môi trường mới, tại `backend/`:

```powershell
node scripts/migrate.js
# Tạo một khóa riêng rồi lưu vào CHAT_ENCRYPTION_KEY trong .env.local.
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm.cmd run dev
```

Giữ khóa 64 ký tự hex này ổn định, tách khỏi khóa Clerk/link mời và không đưa vào
frontend/Git. Sao lưu khóa an toàn cùng hướng dẫn khôi phục: mất hoặc đổi khóa sẽ
không đọc được lịch sử cũ. Thiếu khóa thì chat trả 503, chức năng vẽ vẫn chạy.
Tắt chia sẻ đóng chat/thu quyền; dữ liệu chat vẫn được giữ mã hóa cho lần chia sẻ sau.

Máy local đã áp dụng migration 003, tạo khóa trong file Git ignore và kiểm tra
schema/RLS/startup bằng backend cổng tạm. Ngày 17/11/2026, người dùng xác nhận
hai tài khoản gửi/nhận trực tiếp và F5 giữ lịch sử sau restart. Truy vấn chỉ đọc
đối chiếu 2 tin từ 2 tác giả trong 1 dự án; cả hai bản mã xác thực/giải mã đúng.
Người dùng cũng xác nhận về Cá nhân ẩn chat, thành viên về Studio và URL cũ bị
chặn; sau đó đã bật lại Chung trước lúc đối chiếu SQL. Database khi đó có 2 thành
viên, hai bản mã giữ nguyên; phạm vi kiểm chứng được ghi trong `Plans.md`.
`npm.cmd test` chạy cả kiểm tra mã hóa, rollback, UUID và cách ly HTTP/WebSocket
bằng SQL giả, không cần credentials thật.

## Tối ưu đồng bộ nét và chat

Chạy `node scripts/migrate.js` từ `backend/` rồi khởi động lại backend để bật
migration 004. Backend nhận commit theo UUID, gom tối đa 8 thao tác liền nhau
trong một lô giới hạn 256 KiB. Một câu SQL cấp sequence và ghi lô vào Supabase.
Sau COMMIT, client mới nhận ACK ngắn gồm UUID/sequence và các tab còn lại nhận
nét đầy đủ. Preview tối đa 15 Hz đi riêng qua WebSocket và có thể bị bỏ khi
mạng chậm. Chat dùng một câu SQL để lưu bản mã trước khi phát tin đã lưu.
Lượt tải lịch sử dùng một câu SQL kiểm tra quyền trong cùng mốc đọc và tránh
giữ khóa hàng trong lúc thành viên đang vẽ.

Nét mới lưu dạng `bytea` khi có thể tái tạo nguyên tọa độ và màu. Codec dùng
tọa độ ×100, delta ZigZag varint và RGB 24-bit. Nét JSONB cũ và sự kiện ẩn/hiện
vẫn đọc được. Đặt `DRAWING_PACKED=false` nếu cần tạm giữ JSONB cho nét mới.
Sau khi đã có dòng `bytea`, giữ backend có decoder khi rollback ứng dụng.

Worker tạo PNG trong suốt 1600 × 900 sau mỗi khoảng 300 thao tác, tối đa 512 KiB
và một ảnh mỗi dự án. Ảnh được phục vụ qua API kiểm tra thành viên. Máy khách
nối lại gửi `lastSeq` để nhận phần đuôi theo index `(room_id, sequence)`. Cache
RAM giữ tối đa 16 dự án, mỗi dự án 256 thao tác và 256 KiB. Khi thiếu ảnh,
đuôi quá lớn hoặc có undo/redo ảnh hưởng nét trong ảnh, server giữ đủ vector
để dựng lại. Bộ đếm giới hạn tài liệu 5 MiB tự khởi tạo cho dự án cũ ở lần ghi đầu.

`npm.cmd run test:database` cần migration 004. Ca thử tạo dữ liệu riêng và kiểm
tra JSONB cũ, bytea mới, ACK, bù sequence, restart, retry cùng UUID và rollback
nguyên lô khi một thao tác không ghi được.
