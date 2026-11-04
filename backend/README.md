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

## Chạy và kiểm tra

Chạy bộ test backend độc lập với database từ `backend/`:

```powershell
npm test
```

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

5 test trong `tests/collaboration.test.js` dùng client `ws` thật và repository
PostgreSQL với SQL giả: xác nhận sau COMMIT, phát cùng thứ tự, chống nét trùng,
tải lại trạng thái, nhận đủ nét sau ngắt/nối lại và không xác nhận khi transaction
lỗi. Test mất acknowledgement chủ động ngắt client khi COMMIT đang chờ; retry
sau COMMIT giữ nguyên sequence, retry sau rollback lưu đúng một lần.
4 test trong `tests/rename.test.js` dùng repository PostgreSQL với SQL giả: chủ
đổi tên dự án Cá nhân/Chung, giữ nguyên nét/quyền/sequence, chặn thành viên và
rollback khi UPDATE/COMMIT lỗi. Tổng cộng **66 test backend**, không cần dịch vụ thật.

`src/memory-repository.js` cung cấp `ready()`, `createRoom()`, `listRooms()` và
`getRoom()`, `renameRoom()` cho development/test. Chủ phòng được thêm làm thành viên đầu tiên;
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

## API đổi tên dự án

`PATCH /api/rooms/:id` nhận JSON `{ "title": "Tên dự án mới" }` và Bearer token
Clerk. Chỉ chủ được đổi tên; tên được trim rồi kiểm tra dài 1–100 ký tự, body chỉ
được chứa `title`. Thành công trả `200 { room }` sau COMMIT, cập nhật tên/thời gian
và giữ nguyên chủ, chế độ chia sẻ, sequence, nét vẽ, checkpoint và link.

Thành viên dự án chung nhận 403, người ngoài/phòng không tồn tại nhận cùng 404;
thiếu đăng nhập nhận 401, dữ liệu sai nhận 400, database lỗi nhận 503. CORS cho
phép PATCH từ origin tin cậy. Bước này có API; điều khiển đổi tên trên editor sẽ
được thêm trong Pha 5.

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

Đang ở bước nền tảng: chủ vẫn đọc/vẽ dự án Cá nhân, người khác không được vào
bằng link và nút tạo link cũ được ẩn. API bật/tắt chia sẻ là bước tiếp theo trong
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
