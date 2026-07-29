import { describe, expect, it } from 'vitest'
import { extractRoutes } from './routes.js'

describe('extractRoutes', () => {
  it('三種元件寫法都要抓到', () => {
    const routes = extractRoutes(
      'src/router/modules/demo.ts',
      `
import Eager from '@/views/Eager/IndexView.vue'
const Lazy = () => import('@/views/Lazy/IndexView.vue')

export default [
  { name: 'A', path: '/a', component: Lazy },
  { name: 'B', path: '/b', component: Eager },
  { name: 'C', path: '/c', component: () => import('@/views/Inline/IndexView.vue') }
]
`
    )
    expect(routes.map(r => [r.path, r.componentSpec])).toEqual([
      ['/a', '@/views/Lazy/IndexView.vue'],
      ['/b', '@/views/Eager/IndexView.vue'],
      ['/c', '@/views/Inline/IndexView.vue']
    ])
  })

  it('巢狀 children 要遞迴抓，且無 component 的中繼節點不算漏抓', () => {
    const routes = extractRoutes(
      'src/router/modules/case.ts',
      `
const Mgmt = () => import('@/views/Case/Management/IndexView.vue')
export default [
  {
    path: '/cases',
    redirect: { name: 'NotFound' },
    children: [
      { path: ':caseGid', redirect: { name: 'X' }, children: [
        { name: 'CaseManagement', path: 'management', component: Mgmt }
      ]}
    ]
  }
]
`
    )
    expect(routes.map(r => r.path)).toEqual(['/cases', ':caseGid', 'management'])
    expect(routes.find(r => r.path === 'management')?.componentSpec).toBe('@/views/Case/Management/IndexView.vue')
    expect(routes.find(r => r.path === ':caseGid')?.componentSpec).toBeUndefined()
  })

  it('meta / props 裡的物件字面量不會被誤判成路由', () => {
    const routes = extractRoutes(
      'src/router/modules/demo.ts',
      `export default [{ name: 'A', path: '/a', props: () => ({ id: 1 }), meta: { title: 't' } }]`
    )
    expect(routes).toHaveLength(1)
  })
})
