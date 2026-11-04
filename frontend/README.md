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

Từ `frontend/`, chạy `npm test` (PowerShell có thể dùng `npm.cmd test`). Bộ 24 test
dùng Node test runner: 4 test tọa độ/replay và 20 test store WebSocket với token,
socket, timer giả. Không cần Clerk, Supabase hoặc backend đang chạy. Các test
kiểm tra xác thực, tải trạng thái, đổi phòng/đăng xuất, refresh token, phản hồi
trễ, nét chờ/acknowledgement, thứ tự nét/tẩy, Offline/Online và retry khi tải token
gặp lỗi mạng. Server báo 4401 thì dừng để đăng nhập lại. Test mô phỏng không thay
thế kiểm tra hai tài khoản thật trên trình duyệt. Trường hợp mất acknowledgement
kiểm tra riêng nét đã/chưa lưu, giữ UUID khi retry và giữ nét chờ khi thiếu sequence.

Kiểm tra thủ công: mở cùng phòng bằng hai tài khoản; ở tab A dùng F12 → Network
→ Offline, giữ tab B Online và vẽ thêm nét. Chuyển A về No throttling/Online:
Canvas chỉ cho vẽ sau khi tải lại trạng thái phòng, gồm các nét mới của B.
Không F5 trong lần kiểm tra này; kết quả được theo dõi trong `../Plans.md`.

### Lint with [ESLint](https://eslint.org/)

```sh
npm run lint
```
