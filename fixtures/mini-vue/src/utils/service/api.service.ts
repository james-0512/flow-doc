const apiService = {
  get: (_url: string, _cfg?: unknown) => Promise.resolve({ data: null }),
  post: (_url: string, _data?: unknown) => Promise.resolve({ data: null })
}

export default apiService
