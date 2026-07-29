import { createDemo, getDemoList } from '@/api/demo'

const items: string[] = []

export async function submitDemo(name: string) {
  try {
    await createDemo({ name })
  } catch {
    return null
  }
  items.push(name)
  return name
}

export async function loadDemo() {
  return getDemoList()
}
