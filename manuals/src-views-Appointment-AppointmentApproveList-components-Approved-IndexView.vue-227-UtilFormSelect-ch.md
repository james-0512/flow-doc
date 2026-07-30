## 已核銷：切換服務項目（連動提供者選單）

**觸發**：已核銷分頁變更「服務項目」下拉
`src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:227`

與〈查詢已核銷預約清單〉分開記錄的原因：**它多打一支 API**。行為與待審核分頁的
同名流程完全對稱。

### 步驟

1. **重新查詢已核銷清單** `src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:213-217`
   → `POST /api/v1/verificationLog/list` `src/api/appointment/appointmentList.ts:56`
   並往上發出筆數事件
   `src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:149`

2. **連帶重新取得服務提供者選單** `src/api/appointment/appointmentList.ts:38`
   `GET /api/v1/appointment/serviceProvider/menu`

### 資料變化

| 對象 | 動作 | 位置 |
|---|---|---|
| `POST /api/v1/verificationLog/list` | 唯讀（POST 僅為傳遞篩選條件） | `src/api/appointment/appointmentList.ts:56` |
| `GET /api/v1/appointment/serviceProvider/menu` | 唯讀，取得連動選單 | `src/api/appointment/appointmentList.ts:38` |
| 載入 Store | 兩次查詢各自掛上與解除 | `src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:151` |

### 異常與補償

兩支查詢都沒有 try／catch，部分失敗沒有補償。

### 全域前置

授權標頭注入與錯誤顯示見〈每個請求送出前〉與〈API 錯誤的全域處理〉。
