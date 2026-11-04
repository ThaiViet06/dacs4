# frontend

This template should help get you started developing with Vue 3 in Vite.

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Vue (Official)](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (and disable Vetur).

## Recommended Browser Setup

- Chromium-based browsers (Chrome, Edge, Brave, etc.):
  - [Vue.js devtools](https://chromewebstore.google.com/detail/vuejs-devtools/nhdogjmejiglipccpnnnanhbledajbpd)
  - [Turn on Custom Object Formatter in Chrome DevTools](http://bit.ly/object-formatters)
- Firefox:
  - [Vue.js devtools](https://addons.mozilla.org/en-US/firefox/addon/vue-js-devtools/)
  - [Turn on Custom Object Formatter in Firefox DevTools](https://fxdx.dev/firefox-devtools-custom-object-formatters/)

## Type Support for `.vue` Imports in TS

TypeScript cannot handle type information for `.vue` imports by default, so we replace the `tsc` CLI with `vue-tsc` for type checking. In editors, we need [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar) to make the TypeScript language service aware of `.vue` types.

## Customize configuration

See [Vite Configuration Reference](https://vite.dev/config/).

## Project Setup

Use **Node 24**, version `24.15.0` or newer within that major version. The root
`.nvmrc` and `.node-version` pin `24.22.2`; both applications declare `^24.15.0`.
On Windows, use the [official Node 24.22.2 installer](https://nodejs.org/en/download/archive/v24.22.2),
then open a new terminal and confirm `node --version` before running npm commands.

```sh
npm install
```

### Compile and Hot-Reload for Development

```sh
npm run dev
```

### Type-Check, Compile and Minify for Production

```sh
npm run build
```

### Kiểm tra Canvas và kết nối phòng

Từ `frontend/`, chạy `npm test` (PowerShell có thể dùng `npm.cmd test`). Bộ 76 test
dùng Node test runner: 4 test tọa độ/replay, 27 WebSocket/cache editor, 2 bản nháp,
25 Studio/lifecycle/routing/đổi tên/chia sẻ, 10 cache danh sách và 8 lời mời.
Dùng dịch vụ giả khi cần;
không cần Clerk, Supabase hoặc backend đang chạy. Các test
kiểm tra xác thực, tải trạng thái, đổi phòng/đăng xuất, refresh token, phản hồi
trễ, nét chờ/acknowledgement, thứ tự nét/tẩy, Offline/Online và retry khi tải token
gặp lỗi mạng. Server báo 4401 thì dừng để đăng nhập lại. Test mô phỏng không thay
thế kiểm tra hai tài khoản thật trên trình duyệt. Trường hợp mất acknowledgement
kiểm tra riêng nét đã/chưa lưu, giữ UUID khi retry và giữ nét chờ khi thiếu sequence.

Kiểm tra thủ công: mở cùng phòng bằng hai tài khoản; ở tab A dùng F12 → Network
→ Offline, giữ tab B Online và vẽ thêm nét. Chuyển A về No throttling/Online:
Canvas chỉ cho vẽ sau khi tải lại trạng thái phòng, gồm các nét mới của B.
Không F5 trong lần kiểm tra này; kết quả được theo dõi trong `../Plans.md`.

### Editor Studio dùng chung

| Đường dẫn | Chức năng |
| --- | --- |
| `/studio` | Lưới Cá nhân/Chung, ngày cập nhật và thẻ “+” tạo mới (`StudioView`) |
| `/studio/try` | Bản nháp không lưu, có undo/redo/reset (`DraftView`) |
| `/studio/:id` | Dự án tự lưu, tải quyền/metadata/kết nối (`ProjectView`) |

`/gallery` và `/rooms/:id` cũ chỉ chuyển hướng, giữ query/hash. Các editor dùng
chung `StudioEditor.vue`. Ctrl+Z hoàn tác; Ctrl+Y hoặc Ctrl+Shift+Z làm lại trên
bản nháp, kể cả sau khi chỉnh cỡ bút/màu. Ô nhập văn bản giữ phím tắt riêng.
Dự án tự lưu chưa hỗ trợ undo/redo; giao diện báo rõ giới hạn này.

Chủ dự án có nút **Đổi tên** trong editor, dùng `PATCH /api/rooms/:id` hiện có.
Dialog kiểm tra 1–100 ký tự, chặn gửi trùng, chỉ đổi tên editor/card sau xác nhận;
không thay nét/sequence. Lỗi giữ nội dung nhập để thử lại, phản hồi sau khi rời trang
bị bỏ qua. Chrome với dịch vụ giả đã kiểm tra quyền, lỗi và bố cục 390px;
người dùng đã xác nhận tên editor/card và nét giữ đúng sau mở lại/F5 bằng tài khoản thật.
Kiểm tra quyền thành viên bằng tài khoản thật còn chờ trong `../Plans.md`.

Store `draft.ts` giữ bản nháp và undo/redo độc lập với `board.ts`. Đi qua Trang chủ,
Studio hoặc dự án đã lưu không xóa bản nháp; Tạo trang mới chỉ xóa bản nháp đó.
`board.ts` giữ phiên theo dự án/tài khoản: khi quay lại, Canvas cũ hiện nhưng khóa
vẽ đến khi HTTP kiểm tra quyền và WebSocket trả trạng thái mới. Rời editor đóng
socket, giữ nét chờ để mở lại cùng dự án thì retry UUID cũ, tránh trùng khi ACK mất.

Cache giữ tối đa năm phiên hoàn tất gần nhất; phiên còn nét chờ/lỗi không bị loại.
Link chia sẻ đã tạo giữ cùng phiên nên chuyển trang không cần tạo link mới.
F5/đóng tab xóa RAM (gồm bản nháp/nét chưa xác nhận/link đang nhớ); nét đã được
server xác nhận vẫn nằm trong database. Link HMAC được lấy lại từ API khi chủ mở hộp Chia sẻ sau F5.

Chủ có nút **Chia sẻ** ở cả Cá nhân và Chung. Hộp đọc trạng thái bằng GET, đổi chế
độ bằng PATCH; chỉ đổi editor/card sau xác nhận và chuyển card sang đúng nhóm.
Chờ hết nét chưa xác nhận/lỗi lưu trước khi đổi. Chuyển về Cá nhân có xác nhận
thu quyền; đang ghi thì nút đóng/Esc bị khóa, lỗi giữ chế độ đã xác nhận để thử lại.
Link HMAC hiện ngay và copy được. Dự án dùng link cũ có nút **Cập nhật link**,
kể cả khi URL cũ còn trong cache. Hộp xác nhận nói rõ link trước sẽ hết hiệu lực,
thành viên đang tham gia giữ quyền. Chỉ gọi API sau xác nhận; hủy/lỗi giữ URL cũ,
gửi lại không xoay link thêm lần nữa. Sau thành công, nút cập nhật biến mất và F5
lấy lại đúng link HMAC. Người dùng xác nhận hủy rồi cập nhật bằng hai tài khoản
thật: F5 giữ link/nét, thành viên đang mở tiếp tục vẽ mà không cần tham gia lại.

Socket nhận 4403 dừng retry, xóa cache/nét chờ dự án và đưa thành viên về Studio
với thông báo. Card bị loại ngay, GET trễ không khôi phục card; đổi tài khoản xóa
thông báo. Người nhận link đã đăng nhập được tự tham gia/mở Canvas sau xác nhận
backend. Nếu chưa đăng nhập, trang chờ Clerk rồi tự tiếp tục sau đăng nhập; không
còn nút Tham gia phòng. Link sai/hết hiệu lực báo lỗi, lỗi kết nối có Thử lại và
không tự lặp request. Đổi tài khoản/link hoặc rời trang bỏ phản hồi cũ, request
đang chờ không nhận thêm lần bấm trùng. Test/Chrome với SDK/API/ws giả đạt cho
desktop/390px; luồng đăng nhập thật còn chờ trong `../Plans.md`.

Thẻ dự án mở editor khi bấm. Dialog tạo kiểm tra tên, chặn gửi trùng và có Hủy/Esc.
Server xác nhận tạo thành công thì mở ngay `/studio/:id` theo ID trả về;
quay về Studio hiện ngay card trong cache và cập nhật ngầm. Lỗi hoặc phản hồi trễ sau khi đăng xuất/rời
trang không chuyển sang editor. Chrome với SDK/API/WebSocket giả đã kiểm tra
luồng này, Canvas, lỗi và bố cục 390px. Người dùng đã xác nhận tạo/mở/vẽ/F5 bằng tài khoản thật.

Cá nhân gồm dự án riêng do bạn sở hữu; Chung gồm dự án đang chia sẻ của bạn
hoặc được mời tham gia. Đổi mục lọc dữ liệu đã tải; Tải lại giữ mục đang chọn.
Pinia giữ card và mục đang chọn khi chuyển Trang chủ/Studio. Cache nằm trong RAM,
F5 tải lại danh sách. Tải nền lỗi vẫn giữ card; đăng xuất/đổi tài khoản ở bất kỳ
trang nào hoặc API báo lỗi xác thực sẽ xóa cache. Dự án vừa tạo được thêm ngay,
phản hồi GET cũ không ghi đè thẻ mới. Thời gian cập nhật hiển thị theo trình duyệt.

Chrome đã kiểm tra phím tắt/focus, chuyển trang, giữ bản nháp và link cũ. Test
Vue kiểm tra lifecycle, khóa công cụ, quyền/dialog, bỏ metadata trễ. Bộ lọc/ngày
cập nhật, cache theo tài khoản và phục hồi editor đã kiểm tra Chrome bằng dữ liệu giả;
bật/tắt/copy/F5/thu quyền và 390px cũng đã kiểm tra bằng dịch vụ giả. Người dùng
đã xác nhận hai tài khoản thật: copy/F5 giữ link, tham gia/vẽ, tắt chia sẻ đưa thành
viên về Studio kèm thông báo, chặn link cũ và giữ bản vẽ chủ. Restart backend và
bật lại sau thu quyền còn chờ trong `../Plans.md`.

### Lint with [ESLint](https://eslint.org/)

```sh
npm run lint
```
