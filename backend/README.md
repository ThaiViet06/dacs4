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

28 test trong `tests/auth.test.js` dùng SDK thật với khóa RSA chỉ tồn tại trong bộ
nhớ và repository giả. Chúng kiểm tra token hợp lệ/sai, phản hồi HTTP an toàn và
xác thực WebSocket. Không cần khóa Clerk thật, Supabase hoặc chạy migration.

11 test bổ sung trong `tests/memory-repository.test.js` và `tests/rooms.test.js`
kiểm tra tạo/liệt kê/đọc metadata phòng, cách ly hai tài khoản, chặn giả mạo chủ
phòng, giới hạn danh sách và chống sửa dữ liệu trả về. Tổng cộng 39 test backend.

`src/memory-repository.js` cung cấp `ready()`, `createRoom()`, `listRooms()` và
`getRoom()` cho development/test. Chủ phòng được thêm làm thành viên đầu tiên;
danh sách chỉ chứa phòng của thành viên, mới cập nhật trước, tối đa 100 phòng.
Token mời chỉ trả khi tạo; danh sách/metadata không chứa token hoặc hash nội bộ.

Repository này được inject vào `createApplication()` trong test. Mỗi instance có
dữ liệu RAM riêng và mất dữ liệu khi dừng tiến trình; `server.js` hiện vẫn dùng
PostgreSQL. Tiếp theo sẽ nối giao diện tạo/liệt kê phòng và tham gia bằng link
mời với API thật; không cần thêm chế độ chạy RAM riêng.

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

Chạy lệnh từ `backend/` nếu `DATABASE_CA_FILE` dùng đường dẫn tương đối. Thông tin
đăng nhập database và CA được cấp qua cấu hình hiện có; không tắt kiểm tra TLS.

Entry point là `server.js`. Sau khi hoàn tất dependency và chuẩn bị database:

```powershell
npm run dev       # Chạy bằng nodemon
npm start         # Chạy bằng Node.js
```

Kiểm tra cú pháp cấu hình mà không mở máy chủ hoặc kết nối database:

```powershell
node --check src/config.js
node --check server.js
```

Kiểm tra thật ngày 2026-11-02: kết nối Supabase qua `pg` với chứng chỉ TLS hợp lệ,
repository readiness, `/healthz` (200), `/readyz` (200), và API phòng chưa đăng nhập
(401 `AUTH_REQUIRED`) đều đạt. Backend dừng sạch sau kiểm tra; tiến trình thử nghiệm
không được giữ chạy. Token từ tài khoản thật, tải JWKS của Clerk, thao tác phòng
đã xác thực và lưu/khôi phục nét vẽ vẫn cần kiểm chứng.

Audit ngày 2026-11-02: dependency production không có cảnh báo; audit đầy đủ còn
2 mục moderate trong chuỗi development `nodemon → minimatch` đã tồn tại trước lần
cài này. Việc xử lý được theo dõi trong [Plans.md](../Plans.md).
