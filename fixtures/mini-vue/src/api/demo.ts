import apiService from '@/utils/service/api.service'

export async function createDemo(data: unknown) {
  return apiService.post('/api/v1/demo/create', data)
}

export async function getDemoList() {
  return apiService.get('/api/v1/demo/list')
}
