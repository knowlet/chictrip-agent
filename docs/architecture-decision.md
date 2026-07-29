# 架構決策：ChatGPT 與去趣行程整合

狀態：已採用
適用目標：讓 ChatGPT／Codex 安全讀取去趣行程，規劃後建立或修改行程。

## 決策摘要

採用一套共用的 typed core，外接：

1. JSON CLI：提供可重現、自動化友善的底層介面，以及唯一的真人核准入口。
2. stdio MCP：提供本機 ChatGPT／Codex 結構化 tools。
3. Skill／Plugin：規範 agent 必須先讀取、產生 preview、展示 diff，再等待真人核准。

HTTP MCP 只允許綁定 loopback，供 Secure MCP Tunnel 或受控內部 proxy
轉接；不直接公開到網際網路。長期最佳方案是取得去趣官方 partner API、
正式 OAuth／權限模型與書面自動化授權後，替換目前的 browser provider
adapter，而保留 typed core、CLI 與 MCP tool contracts。

## 方案比較

| 方案 | ChatGPT 易用性 | 安全與寫入風險 | 可測性 | 維護成本 | 評估 |
|---|---|---|---|---|---|
| 純 browser automation | 可操作現有 UI，但流程長且 agent 難取得穩定結構化結果 | 高；selector、焦點、彈窗或 UI 改版都可能造成誤寫 | 低；E2E 慢且容易受畫面狀態影響 | 高；UI 小改就可能失效 | 僅用於登入、契約探索與沒有 API 的最後 fallback |
| 純 CLI | 本機與其他 agent 容易呼叫；ChatGPT Web 不會自然發現命令與 schema | 中低；可做 preview、revision 與互動確認 | 高；JSON input/output 容易 fixture 與 contract test | 中；命令相容性需維護 | 保留為核心操作與除錯介面，不單獨作為 ChatGPT 整合 |
| stdio MCP | 本機 ChatGPT／Codex 最直接，tool schema、錯誤與 annotations 清楚 | 低；不開網路 port，且可完全移除 agent 自我核准能力 | 高；可用 MCP client 做 tool contract test | 中低；thin adapter 共用 typed core | 本機主要 agent 介面 |
| HTTP MCP | ChatGPT Web 與遠端 client 較容易連接 | 中高；若直接公開，會擴大憑證、重放與未授權寫入面 | 高；協定可測，但部署、驗證、rate limit 另增複雜度 | 高於 stdio | 僅允許 loopback 加 Secure MCP Tunnel；不得為了連線關閉 bearer 驗證 |
| CLI + Skill | Skill 能教 agent 正確順序，CLI 保留透明、可人工執行的命令 | 低至中；安全取決於 CLI 是否強制核准，Skill 本身不是安全邊界 | 高；CLI contract 與 Skill 行為可分別驗證 | 中低 | 作為 stdio MCP 的互補與可攜工作流 |
| Browser extension + native host | 能重用瀏覽器情境，安裝後操作方便 | 中高；extension 權限、更新供應鏈與 native messaging 都是額外攻擊面 | 中；需同時測 extension、瀏覽器與 native host | 高；跨瀏覽器、簽章與發佈成本大 | 目前不採用；只有需要長期瀏覽器內 UX 時再評估 |
| 官方 partner API | 最適合 ChatGPT；可有穩定 schema、OAuth、scope 與 idempotency | 最低；前提是官方提供細粒度權限、稽核與寫入契約 | 最高；可建立正式 sandbox 與 contract suite | 長期最低，初期商務整合成本最高 | 長期最佳解，也是商業／多人使用的必要方向 |

## 為何採用組合式架構

typed core 集中處理 provider normalization、revision、diff、idempotency 與
write claim，避免 CLI、MCP 和 Skill 各自實作一套不同安全規則。JSON CLI
是可觀測且容易測試的底層介面；stdio MCP 只做薄的 tool mapping；Skill／Plugin
則負責告訴 agent 何時讀取、何時 preview，以及哪些能力必須停止。

這個分層也讓 provider 可以替換：目前是專用 Chrome profile 內執行的未公開
web endpoint adapter；未來若取得官方 API，只需新增正式 transport，不必重寫
ChatGPT tools 或使用流程。

## 強制安全流程

任何寫入都必須依序經過：

1. 重新讀取行程與 provider revision。
2. 建立只讀 preview，固定完整 execution plan、diff、帳號與 transport。
3. 使用者在互動式本機 CLI 執行 `changes approve`，輸入精確的
   `APPLY <reviewCode>`。MCP 沒有 approval tool，agent 不能批准自己的操作。
4. apply 以同一個 preview、intent hash 與 idempotency key 原子取得一次
   write claim。每個 preview 最多只有一次 provider 寫入嘗試。
5. 寫入前再檢查 revision，完成後回讀驗證。`conflict`、`partial` 或
   `indeterminate` 不得換新 idempotency key 盲目重試。

approval grant 短效、一次性，保存在本機受限權限 state；secret 不經 argv、
stdout 或 MCP 傳給模型。

帳號綁定在 browser page 內原子擷取 `memberId`、access token 與 refresh
token，並要求 access token 的 JWT `sub` 等於 `memberId`；digest 等待期間
tuple 若改變即停止。refresh 後的新 token 也必須維持相同 subject，認證值
不會回傳 Node、CLI、MCP 或模型。

## 現階段能力邊界

- 目前 adapter 使用未公開的去趣 web endpoints，所有寫入預設關閉。
- `add_item` 採目前公開 web bundle 的 `p1` `GetAddWhere → Add`
  契約，並以回讀 ID 差集及必要時的同日 Sort 對帳；除總寫入旗標外，還
  必須另開景點新增旗標。`p2` 只有假成功畫面，不作為 provider 契約。
- `move_item` 只允許同一天內排序；跨日移動沒有已驗證的安全契約，會在送出
  provider 寫入前阻擋。
- 修改 metadata、既有景點、刪除景點與同日排序仍須經完整 preview、真人
  CLI approval、revision check、一次 write claim 與回讀驗證。
- browser automation 僅保存登入情境與執行 allowlist request；不將密碼、
  Cookie、access token 或 refresh token 輸出給 CLI、MCP 或模型。

## 重新評估條件

出現下列任一情況時重新檢視本決策：

- 去趣提供正式 partner API、OAuth 或 sandbox。
- 官網出現可重現且獲允許的新增景點或跨日移動契約。
- ChatGPT 的本機 connector 能直接使用 stdio，不再需要 tunnel。
- 需求擴大到多人、商業部署、共編邀請、付款或其他高風險交易。
