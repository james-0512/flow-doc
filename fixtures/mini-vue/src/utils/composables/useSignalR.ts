import { ref } from 'vue'

export interface HubLike {
  on(event: string, cb: (...args: unknown[]) => void): void
}

/** 推播連線的包裝層。訂閱點在呼叫端，這裡只是轉發。 */
export function useSignalR() {
  const connection = ref<HubLike | null>(null)
  const handlers = new Map<string, (...args: unknown[]) => void>()

  function subscribe(event: string, cb: (...args: unknown[]) => void) {
    handlers.set(event, cb)
    // 轉發層：事件名是變數，沒有可信的來源，不該被當成流程起點
    connection.value?.on(event, cb)
  }

  return { connection, subscribe }
}
