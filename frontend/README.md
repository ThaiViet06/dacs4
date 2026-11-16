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

Từ `frontend/`, chạy `npm test` (PowerShell có thể dùng `npm.cmd test`). Bộ 141 test
dùng Node test runner: 4 test tọa độ/replay, 61 WebSocket/cache/lịch sử, 2 bản nháp,
34 Studio/lifecycle/routing/đổi tên/chia sẻ, 10 cache danh sách, 11 lời mời,
6 tài liệu v1/v2, 9 API và 4 helper xác thực.
Dùng dịch vụ giả khi cần;
không cần Clerk, Supabase hoặc backend đang chạy. Các test
kiểm tra xác thực, tải trạng thái, đổi phòng/đăng xuất, refresh token, phản hồi
trễ, nét chờ/acknowledgement, thứ tự nét/tẩy, Offline/Online và retry khi tải token
gặp lỗi mạng. Server từ chối phiên hoặc SDK không còn token thì dừng để đăng nhập lại. Test mô phỏng không thay
thế kiểm tra hai tài khoản thật trên trình duyệt. Trường hợp mất acknowledgement
kiểm tra riêng nét đã/chưa lưu, giữ UUID khi retry và giữ nét chờ khi thiếu sequence.

Kiểm tra thủ công: mở cùng phòng bằng hai tài khoản; ở tab A dùng F12 → Network
→ Offline, giữ tab B Online và vẽ thêm nét. Chuyển A về No throttling/Online:
Canvas chỉ cho vẽ sau khi tải lại trạng thái phòng, gồm các nét mới của B.
Không F5 trong lần kiểm tra này; kết quả được theo dõi trong `../Plans.md`.

Mỗi dự án giới hạn 10 kết nối; mỗi tab editor tính một kết nối, kể cả cùng tài
khoản. Hết chỗ sẽ khóa vẽ, dừng retry tự động và giữ nét chờ trong RAM. Đóng bớt
tab vẽ hoặc chờ người khác rời dự án rồi bấm **Kết nối lại**; trạng thái server
được đối chiếu trước khi retry nét bằng UUID cũ. Nghiệm thu: mở tổng cộng 11 tab
cùng dự án, kiểm tra tab bị chặn và khả năng vẽ tiếp sau khi có chỗ trống.

Server báo lỗi ghi cho UUID đang chờ thì giữ cảnh báo **Chưa xác nhận lưu** và
khóa vẽ/preview/chia sẻ trong lúc phục hồi. Kết nối trở lại chưa đủ để báo đã lưu:
phải đối chiếu trạng thái rồi nhận xác nhận cho hết lệnh chờ. Retry dùng UUID cũ;
nét đã lưu nhưng mất xác nhận không gửi trùng. Cảnh báo và nét chờ giữ theo dự án
trong RAM khi chuyển trang, xóa khi đăng xuất/đổi tài khoản hoặc F5/đóng tab.
Lệnh bị từ chối có thông báo chưa lưu riêng. Lỗi ghi được test bằng SQL giả;
nghiệm thu Supabase thật dùng dữ liệu test tách biệt theo `../Plans.md`.

API có thời gian chờ 75 giây cho cả kết nối và đọc JSON. Trang mở dự án phân biệt
mất mạng, timeout, dịch vụ chưa sẵn sàng và giới hạn yêu cầu; lỗi tạm thời giữ
cache nhưng chỉ kết nối sau khi kiểm tra lại quyền. Phản hồi HTML không được coi
là thành công; yêu cầu ghi không tự gửi lại khi chưa có xác nhận.
Kiểm tra thêm: từ Studio bật Offline rồi mở dự án đã lưu để xem thông báo mạng;
về Online và bấm **Tải lại**, kiểm tra tên/nét và vẽ tiếp. Test giả đã đạt;
nghiệm thu trình duyệt thật được theo dõi trong `../Plans.md`.

HTTP 401 khi mở dự án có nút **Đăng nhập lại**, sau đó bấm **Tải lại** để kiểm tra
quyền. WebSocket 4401/lỗi xác thực khóa vẽ và dừng retry; nét chờ vẫn giữ trong RAM
cho cùng tài khoản. Đăng nhập lại rồi bấm **Kết nối lại**: lấy token mới, nhận trạng
thái server trước khi retry cùng UUID; nét đã lưu nhưng mất ACK không được gửi trùng.
Lỗi mạng khi tải token vẫn được thử lại, không giả thành hết phiên. Đăng xuất/đổi
tài khoản xóa cache; F5/đóng tab cũng mất nét chưa xác nhận trong RAM.
Kiểm tra thủ công: chờ nét đã lưu, đăng xuất ở tab khác; editor cũ phải khóa/ẩn.
Đăng nhập lại và mở dự án để kiểm tra nét đã lưu. Thu hồi/hết phiên Clerk thật cần
nghiệm thu riêng; kết quả nằm trong `../Plans.md`.

Model đã có `DrawingDocumentV2` và sự kiện `visibility` tham chiếu UUID nét gốc.
`normalizeDocument()` sao chép dữ liệu v1/v2 sang v2, giữ hình học/lịch sử và dùng
được với Pinia/Vue reactive. `getVisibleOperations()` lấy các nét đang hiện theo
thứ tự ban đầu, kể cả khi làm lại nét tẩy. Board đã chuẩn hóa tài liệu nhận được,
giữ lịch sử đầy đủ và chỉ đưa nét đang hiện lên Canvas/nhãn số nét. Thao tác chờ
có hiệu ứng tạm thời; backend từ chối quyền thì gỡ hiệu ứng, giữ bản ghi lỗi.
Export vẫn có nét bị ẩn, lịch sử và thao tác chờ/lỗi để tránh mất dữ liệu.

WebSocket dùng `{ v: 2, type, ... }` ở cả hai phía, đọc được tài liệu v1/v2.
Preview chỉ chứa nét; ẩn/hiện gửi bằng commit, chỉ chủ Cá nhân khi không còn thao
tác chờ/lỗi. Reconnect đối chiếu UUID trong toàn bộ lịch sử, gồm nét bị ẩn.
Backend khác phiên bản thì khóa vẽ và giữ thao tác chờ trong RAM; cập nhật backend
rồi bấm **Kết nối lại** để khôi phục thao tác chờ. Ngày 16/11/2026, người dùng
xác nhận hai tài khoản thật vẽ/hình/tẩy đồng bộ, F5 giữ nét/vẽ tiếp và Offline/Online
khóa vẽ/tự nối lại/nhận đủ nét mới. Nút/phím undo/redo Cá nhân đã có; nghiệm thu
trên dự án đã lưu và lưu bền sự kiện ẩn/hiện trên Supabase thật theo `../Plans.md`.

### Editor Studio dùng chung

Dùng thẻ dự án hoặc thẻ “+” trên `/studio` để mở editor tự lưu `/studio/:id`.

| Đường dẫn | Chức năng |
| --- | --- |
| `/studio` | Lưới Cá nhân/Chung, ngày cập nhật và thẻ “+” tạo mới (`StudioView`) |
| `/studio/try` | Bản nháp không lưu, có undo/redo/reset (`DraftView`) |
| `/studio/:id` | Dự án tự lưu, tải quyền/metadata/kết nối (`ProjectView`) |

`/gallery` và `/rooms/:id` cũ chỉ chuyển hướng, giữ query/hash. Các editor dùng
chung `StudioEditor.vue`. Ctrl+Z hoàn tác; Ctrl+Y hoặc Ctrl+Shift+Z làm lại trên
bản nháp hoặc dự án Cá nhân do bạn sở hữu. Ô nhập văn bản và dialog giữ phím tắt
riêng; chế độ Chung không có điều khiển undo/redo.

Lịch sử dự án chỉ gồm nét mới của lần mở editor; nét/tẩy được ẩn/hiện bằng sự
kiện, không xóa nét gốc. Nút khóa khi chờ lưu, lỗi hoặc mất mạng; stack chỉ chuyển
sau ACK hoặc room.state xác nhận UUID. ACK lặp/mất không chuyển stack hai lần.
Vẽ nét mới đã xác nhận sẽ bỏ nhánh redo. F5, rời editor, đổi tài khoản/chế độ bắt
đầu stack mới; đổi tên không xóa stack. Reconnect cùng phiên giữ stack, còn thay
đổi ẩn/hiện từ tab khác bắt đầu lịch sử mới trên tài liệu chuẩn. Bản nháp vẫn có
lịch sử riêng như trước. Ngày 16/11/2026, người dùng xác nhận Ctrl+Z/Y và F5 trên
dự án Cá nhân đã lưu giữ đúng kết quả; restart backend tự nối lại, giữ bản vẽ và
vẽ/undo tiếp được. Đối chiếu Supabase chỉ đọc xác nhận lịch sử cũ không đổi.

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
còn nút Tham gia phòng. Link thiếu token (`/invite/`) hoặc sai định dạng báo lỗi trước khi yêu cầu đăng nhập.
Server xác nhận link vô hiệu thì hướng dẫn xin link mới, ẩn Thử lại và chặn gửi
cùng link hỏng. Lỗi phiên có Đăng nhập lại; lỗi kết nối/dịch vụ có Thử lại và không
tự lặp request. HTML/404 từ dịch vụ chưa đủ để kết luận link vô hiệu.
Đổi tài khoản/link hoặc rời trang bỏ phản hồi cũ, request
đang chờ không nhận thêm lần bấm trùng. Test/Chrome với SDK/API/ws giả đạt cho
desktop/390px. Ngày 16/11/2026, người dùng xác nhận bằng hai tài khoản thật:
đăng nhập xong hoặc mở link khi đã đăng nhập đều tự vào đúng Canvas và vẽ đồng bộ.

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
viên về Studio kèm thông báo, chặn link cũ và giữ bản vẽ chủ. Ngày 16/11/2026,
hai tài khoản xác nhận restart backend vẫn giữ link/bản vẽ và vẽ đồng bộ được.
Hai tài khoản cũng xác nhận tắt/bật lại: thành viên bị thu quyền, URL editor/link
cũ bị chặn; link mới cho tham gia lại, giữ nét và vẽ đồng bộ. Các kiểm tra còn lại
theo `../Plans.md`.

### Lint with [ESLint](https://eslint.org/)

```sh
npm run lint
```
