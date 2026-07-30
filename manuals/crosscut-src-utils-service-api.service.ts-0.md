## 每個請求送出前（請求攔截器）

**觸發**：**每一次** API 呼叫送出前，無例外。所有流程的後端互動都會經過這裡。

### 步驟

1. **帶上 cookie** `src/utils/service/api.service.ts:41`
   `withCredentials = true`。

2. **注入授權標頭** `src/utils/service/api.service.ts:42`
   有 token 才加。這是各流程的敘述裡看不到「怎麼帶身分」的原因——所有請求的
   `Authorization: Bearer <token>` 都在這一行統一補上。

3. **注入語言標頭** `src/utils/service/api.service.ts:43`
   `Accept-Language` 取自 i18n 當前語系。後端據此回傳對應語言的訊息，
   所以錯誤提示的語言是在這裡決定的，不在呼叫端。

4. **注入裝置識別碼** `src/utils/service/api.service.ts:45`
   `serialNo` 與 `systemNo` `src/utils/service/api.service.ts:46`。
   兩者都是「呼叫端已指定就沿用，否則取 Electron 裝置資訊」的寫法——讓個別請求
   可以覆寫，同時在 Electron 環境自動補齊。純瀏覽器環境取不到裝置資訊時送
   `undefined`，等於不帶。

### 資料變化

無。這個攔截器只改寫送出的請求標頭，不寫任何應用狀態。

### 異常與補償

見「請求錯誤」一節。

### 未追蹤的部分

**這個攔截器的實質工作全是屬性賦值，而分析器只追函式呼叫**，因此自動產生的
副作用清單只會列出兩個 store 的取得
（`src/utils/service/api.service.ts:39`、`src/utils/service/api.service.ts:40`）。
上述四個注入步驟是直接讀原始碼寫成的，不在自動分析的結果裡。
