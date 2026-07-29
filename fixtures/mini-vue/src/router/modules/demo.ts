const DemoView = () => import('@/views/Demo/IndexView.vue')

export default [
  {
    name: 'Demo',
    path: '/demo',
    component: DemoView
  }
]
