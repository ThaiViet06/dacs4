import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import StudioView from '../views/StudioView.vue'
import GalleryView from '../views/GalleryView.vue'
import RoomView from '../views/RoomView.vue'
import InviteView from '../views/InviteView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/studio', name: 'studio', component: StudioView },
    { path: '/gallery', name: 'gallery', component: GalleryView },
    { path: '/rooms/:id', name: 'room', component: RoomView },
    { path: '/invite/:token', name: 'invite', component: InviteView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

export default router
