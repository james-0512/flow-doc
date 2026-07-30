---
covers:
  - src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:243:UtilFormSelect:change
  - src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:252:UtilFormInput:clear
  - src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:278:UtilTable:change-limit
  - src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:279:UtilTable:change-page
---

## 查詢已核銷預約清單

**觸發**：已核銷分頁上**八個**控件都走這條路徑：

| 控件 | 位置 |
|---|---|
| 查詢鈕 | `src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:256` |
| 狀態下拉 | `src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:235` |
| 狀態下拉（第二組） | `src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:243` |
| 關鍵字按 Enter | `src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:253` |
| 關鍵字清空 | `src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:252` |
| 日期選擇 | `src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:268` |
| 變更每頁筆數 | `src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:278` |
| 換頁 | `src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:279` |

**與〈查詢待審核預約清單〉的差別**：兩者呼叫**同一支端點**
`src/api/appointment/appointmentList.ts:56`，只是送出的審核狀態條件不同。已核銷分頁
也同樣會往上發筆數事件，所以待審核筆數在切換分頁時仍維持正確。

### 步驟

1. **掛上載入狀態** `src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:143`

2. **查詢清單** `src/api/appointment/appointmentList.ts:56`
   `POST /api/v1/verificationLog/list`——查詢用 POST 傳遞篩選條件，不是寫入。

3. **往上通知筆數** `src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:149`

4. **解除載入狀態** `src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:151`

### 資料變化

| 對象 | 動作 | 位置 |
|---|---|---|
| `POST /api/v1/verificationLog/list` | 唯讀（POST 僅為傳遞篩選條件） | `src/api/appointment/appointmentList.ts:56` |
| 載入 Store | 掛上後解除 | `src/views/Appointment/AppointmentApproveList/components/Approved/IndexView.vue:151` |

### 異常與補償

沒有 try／catch。失敗由全域 API 回應攔截器處理，清單維持前一次內容且不發筆數事件。

### 全域前置

授權標頭注入與錯誤顯示見〈每個請求送出前〉與〈API 錯誤的全域處理〉。
