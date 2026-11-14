# 獨立結算方案收尾

2026-11-14。本次範圍固定為既有改動及架構文件，沒有追加功能或新一輪架構設計。

- [x] 唯一執行入口與獨立結算模組已寫入源碼。
- [x] 聊天、群聊與 Bot 互叫已接入；正式訊息由結算模組保存。
- [x] 已移除被替代的舊執行、寫入、佇列、租約、回呼及專用工作接線。
- [x] 已讀回剩餘 12 個檔案及直接接線；移除部署驗證對已刪除多副本設定的引用。
- [x] 架構文件與本計畫已改為現有實作。
- [x] 已用完授權的兩輪建置／啟動；第 2 輪仍有問題，已依指示停止，未進入實際對話。

此文件隨收尾改動提交；commit／push 的實際結果以本次對話的 Git 交付為準。

## 兩輪實際結果

1. 前端建置因新對話頁殘留 `seedMessage` 匯入而失敗。已刪除該匯入，直接顯示使用者實際送出的文字，沒有恢復自動開場。
2. 前端成品、`openduet-agent-computer:latest` 與 `openduet-supervisor:latest` 均建置成功。後端啟動在 `toolkit/src/native-agent.ts` 匯入 `@ai-sdk/openai` 時失敗：`Cannot find module '@ai-sdk/openai'`。該依賴已在 toolkit manifest 與 lock 宣告；本輪沒有再安裝依賴或重試解析。

已停止後續安裝、修復、建置、啟動與實際對話；沒有第三輪。這次啟動的 PostgreSQL 與 supervisor 已停止。舊的三個已停止電腦容器已移除，原有 profile／workspace 命名 volume 保留；新電腦映像已產生，但沒有完成 Bot 實際運作。

未建立、修改或執行測試；未執行 lint／typecheck。源碼已保存不代表建置或運行成功。狗屎形狀庫與 Slop 已在另一個 repo 推送完成，這裡不重複記錄其工作狀態。

## 依賴阻塞的追加授權與結果

使用者另行允許最多兩輪，只處理 `@ai-sdk/openai` 的安裝／解析阻塞，不擴大重構。

- 第 1／2 輪在 `openbot/` 執行 `bun install --frozen-lockfile --ignore-scripts`，成功安裝 58 個套件，沒有執行安裝腳本。
- 已讀回 toolkit 的實際連結與套件 metadata：`@ai-sdk/openai` 3.0.99 已安裝於工作區的 Bun 套件目錄。manifest、版本及 lockfile 均未變動，不需要修改模型或執行邏輯。
- 直接啟動正式後端後，原缺少 OpenAI 套件的錯誤不再出現；啟動改為停在 `SyntaxError: Export named 'MessageSchema' not found`。來源是 `server/src/runtime/routes.ts:1` 從 `@ag-ui/core` 匯入該符號。
- 這是另一個源碼匯入問題，依「只處理這個阻塞」的範圍未作修改，亦未使用第 2 輪重跑。沒有新增建置、啟動前端或進入實際對話。
- 本輪啟動的 PostgreSQL 與 supervisor 已停止。未跑測試、lint、typecheck，未新增或修改測試檔。

本次只更新這份紀錄與架構文件；實際依賴安裝位於不提交的 `node_modules`。commit／push 結果以本次對話的 Git 交付為準。

## MessageSchema 與同類阻塞收尾

使用者另行授權修正 MessageSchema 及後續同類阻塞，明確解除這類工作的兩輪限制；不擴大重構，仍禁止測試及子代理。

- `runtime/routes.ts` 改從安裝版本正式提供的 `@ag-ui/core/schemas` 匯入 `MessageSchema`，後端成功監聽 3001；既有前端成品成功監聽 3010。
- 實際對話先遇到 `messages[1]` 是字串的 SDK 錯誤。定位到 `settlement.ts` 將已序列化的字串直接綁定為 JSONB，Bun 會再編碼一次；所有該流程的 JSON 參數改以 `::text::jsonb` 傳入，初始化亦修復先前保存成 JSON 字串的訊息、事件及 run 欄位。
- 套用修正後，已有發言可正常恢復顯示。下一步遇到 `http://localhost:4201/ag-ui` 拒絕連線；現有保險 Bot 配置的 LangGraph 容器原本停止，已建置目前源碼並以原有模型環境載入。部署沒有保留已刪除檔案的舊 bind mount、舊工具回呼設定或健康檢查。
- 最後在正式入口選擇既有「保險 PDF 文案總監」，實際收到兩句香港繁體中文回覆，生成結束後介面恢復可輸入狀態。沒有自動重播失敗訊息或冒稱舊的失敗 run 成功。
- API、前端、PostgreSQL、supervisor、模型服務及該 Bot 的電腦保持運行。沒有重建未改動的前端，沒有執行測試、lint、typecheck 或另開子代理。

本次程式碼只修改 runtime 的匯入及 JSON 保存接線，文件同步記錄實際結果。Bot 名單實際仍包含「Your agent」及「OpenDuet」兩個舊項目，本次沒有擴大清理。這次對話未執行瀏覽器操作或 Bot 委派，不能據此宣稱這些流程均已運行成功。

## 刪除預設項目、角色指令及上網／PDF 實際運作

- 使用者明確要求刪除兩個舊預設 Bot，並確認介面所述的全體刪除影響。已透過管理介面刪除「Your agent」及「OpenDuet」，名單讀回只剩「保險 PDF 文案總監」。歷史對話與瀏覽器資料沒有一併清除。
- 起初的上網要求被該 Bot 私人角色中的禁止上網／轉交另一助理指令拒絕。使用者隨後明確要求修改角色；已保留原有保險文案規格，替換該限制，允許使用現有瀏覽器及讀取上載文件，並將銷售稿格式限於文案任務。完整私人指令未寫入公開 repo。
- 實際上網成功：Bot 呼叫瀏覽器開啟 `https://education.ia.org.hk/tc/product/life-insurance.html`，介面記錄「已瀏覽 1 個網頁」，回覆頁面標題及五種人壽保險類型。
- 以保監局公開的《認識人壽保險》原始 PDF 作實際上載。第一次送出時附件已被前端錯誤清除，模型載入失敗；來源是新附件結構將 metadata 放在 `source`，但 composer 仍從附件頂層找 ID，誤判為孤立暫存檔。
- `composer.tsx` 的送出移交及暫存清理兩處統一從 `attachment.source` 讀 ID；截短提示只套用於文字 MIME，不再誤套在 PDF。沒有改動後端附件權限。
- 前端建置成功並已載入。重新上載同一公開 PDF 後，Bot 能讀出文件名稱、第 2 頁四項注意事項標題，以及最後一頁的機構／聯絡資料；介面正常結束生成，畫面已保存供交付。
- 本次只執行使用者指定的實際上網、PDF 操作與必要建置；沒有新增或修改測試內容，沒有跑測試套件、lint、typecheck 或子代理。Bot 委派、群聊與日程沒有藉此擴大執行。

角色及 Bot 刪除已保存於部署資料；Git 只提交附件修正與結果文件。commit／push 的實際結果以本次對話的 Git 交付為準。

## Bot 雙向互叫、對外作者及重連

使用者指定直接跑既有保險 Bot 與自己建立的 `test` Bot，發現問題直接修、不擴大重構、不跑測試套件。本輪另行明確要求開滿代理，三個子代理分別追查 SSE、訊息分層與公開／內部投影；實際操作由主代理完成。

- 初次實際呼叫已復現：`test` 叫到保險 Bot，但 child 重做原使用者的委派要求，查名單後以為找不到自己。另發現 Native 模型沒有取得自己的真實名稱／ID，而 `message_bot` 描述仍要求同伴直接對人回答。
- 身份進入 Native／Remote 模型輸入；當前委派以 model-only `bot_request` 放在歷史之後，sender 由真 parent run 推導，recipient 為真 child Bot。任務文字保持 request 資料，不升格 system，亦不落成人類發言。
- 最外層 Bot 統一對外回答，child 直接聊天與側欄預覽不公開。依使用者補充，root 的既有工具紀錄仍可檢視：協作小標預設收起，展開才顯示雙方任務、回傳內容、狀態及錯誤；沒有新增端點、schema 或另一份對話紀錄。
- 公開 active/last run 選 root，模型只額外讀自己的 private run，不讀其他 child。真正需要人的問題保留真 leaf call ID；content-free root update 讓 child 再次等待時能更新現有問題卡。
- 反覆重連的來源是 API 已關閉 thread SSE 閒置逾時、前端代理卻仍使用預設逾時。已補齊代理設定、初始連線 comment 及單一 15 秒 keepalive；不新增資料庫輪詢或平行重連器。本輪互叫及其後閒置觀察未再看到反覆重連提示；沒有另外做斷網或故障注入。
- 實際 `test` → 保險 Bot：root `17ec9828-97b0-4a65-9607-8cc5144b46d1`，child `35fe7002-4393-48aa-a87a-3e0444637782` 均 completed；root 真正執行 list_bots、message_bot，child 回傳任務結果，由 test 整理對人回覆。
- 實際保險 Bot → `test`：root `e50bc84f-4d56-4add-9996-59cd4e4b8377`，child `dd64b131-db9c-4e7f-9868-36233503ffd4` 均 completed；主對話只見保險 Bot 最終回覆。已實際展開協作小標，能查看保險 Bot → test 的任務及 test → 保險 Bot 的結果。
- 舊的中止協作若沒有結果，不再永久標為處理中。前端成品已建置並載入，API／app 仍在運行。沒有新增或執行測試案例、測試套件、lint 或 typecheck。

同一工作樹有另一個正在進行的工作，使用者已確認。其 Google AI、瀏覽器及模型上下文改動保留；本輪只提交互叫、對外作者、協作小標及 SSE 相關檔案／hunk，不把另一工作混入提交。
