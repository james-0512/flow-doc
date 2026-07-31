## 刪除 iCope 評估紀錄

**觸發**：iCope 評估紀錄清單某筆紀錄的下拉選單按「刪除」
`src/views/Form/_FormGid/ICopeRecord/IndexView.vue:311`

與其他刪除不同，這裡**沒有獨立的確認視窗元件**——用共用的 confirm 視窗攔一次。

### 步驟

1. **先跳確認視窗** `src/views/Form/_FormGid/ICopeRecord/IndexView.vue:179-186`
   以共用 `showConfirmModal`（`src/utils/composables/useModal.ts:59-61`）詢問
   「移除表單紀錄」；按取消就中止，不打後端。

2. **送出刪除** `src/views/Form/_FormGid/ICopeRecord/IndexView.vue:188-190`
   帶 `responseId` → `DELETE /api/v1/form/response`（**寫入**） `src/api/form.ts:358`。
   期間掛上載入狀態。

3. **成功後提示並重查** `src/views/Form/_FormGid/ICopeRecord/IndexView.vue:191-192`
   顯示「刪除成功」，經 `updateList`（`src/utils/functions/execute.ts:16-22`）
   重算頁碼——**最後一頁只剩一筆時自動退到前一頁**——再走
   〈查詢 iCope 評估紀錄〉重查 `GET /api/v1/formManagement/icope/record/list`。

### 序列圖

```mermaid
sequenceDiagram
    participant U as 使用者
    participant I as iCope 評估紀錄頁
    participant API as 後端

    U->>I: 選單按「刪除」
    I->>U: 確認視窗
    U->>I: 確認
    I->>API: DELETE /api/v1/form/response
    API-->>I: 成功
    I->>I: 顯示「刪除成功」、必要時頁碼退一
    I->>API: GET /api/v1/formManagement/icope/record/list
    API-->>I: 最新清單
```

### 資料變化

| 對象 | 動作 | 位置 |
|---|---|---|
| `DELETE /api/v1/form/response` | **寫入**，刪除評估紀錄 | `src/api/form.ts:358` |
| `GET /api/v1/formManagement/icope/record/list` | 唯讀，刪除後重查 | `src/api/form.ts:575` |
| 提示 Store | 顯示成功訊息 | `src/views/Form/_FormGid/ICopeRecord/IndexView.vue:191` |
| 載入 Store | 掛上與解除 | `src/views/Form/_FormGid/ICopeRecord/IndexView.vue:188` |

### 異常與補償

- 刪除 API 沒有 try／catch，失敗由全域 API 回應攔截器統一顯示錯誤（見全域前置）；
  失敗時不提示、不重查，清單維持原狀與後端一致，可直接重試。
  「解除載入狀態」在 `await` 之後，失敗時依賴攔截器安全網。

### 全域前置

授權標頭注入與錯誤顯示見〈每個請求送出前〉與〈API 錯誤的全域處理〉。
