import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import StudioView from '../views/StudioView.vue'
import DraftView from '../views/DraftView.vue'
import ProjectView from '../views/ProjectView.vue'
import InviteView from '../views/InviteView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/studio', name: 'studio', component: StudioView },
    { path: '/studio/try', name: 'studio-try', component: DraftView },
    { path: '/studio/:id', name: 'studio-project', component: ProjectView },
    // Bộ sưu tập cũ dùng chung danh sách Studio; giữ tham số của các link đã lưu.
    {
      path: '/gallery',
      redirect: (to) => ({ name: 'studio', query: to.query, hash: to.hash }),
    },
    // Giữ link phòng cũ nhưng chỉ có một màn hình vẽ dự án trong Studio.
    {
      path: '/rooms/:id',
      name: 'room',
      redirect: (to) => ({
        name: 'studio-project',
        params: { id: to.params.id },
        query: to.query,
        hash: to.hash,
      }),
    },
    // Link bị cắt mất token vẫn vào trang lời mời để báo lỗi rõ ràng, không chuyển về Trang chủ.
    { path: '/invite/:token?', name: 'invite', component: InviteView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

export default router
