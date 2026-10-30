import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { clerkPlugin } from '@clerk/vue'

import App from './App.vue'
import router from './router'
import { clerkPublishableKey } from './services/clerk'
import './styles.css'

const app = createApp(App)

// Có khóa thì cung cấp trạng thái Clerk cho ứng dụng; chưa có khóa vẫn mở được Studio cá nhân.
if (clerkPublishableKey) {
  app.use(clerkPlugin, { publishableKey: clerkPublishableKey })
}

app.use(createPinia())
app.use(router)

app.mount('#app')
