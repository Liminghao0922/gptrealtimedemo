# Azure Portal Function App 创建截图集

本文件夹包含通过 Azure Portal UI 创建 Function App 的完整截图，用于 `docs/azure-functions-portal-ja.md` 教程文档。

## 截图清单

### 1. **search.png** - 搜索 Function App
- 门户搜索框输入 "Function App"
- 展示搜索结果下拉菜单
- 用于教程第1步（门户导航）

### 2. **hosting-plan.png** - 选择托管计划
- Flex Consumption 计划选择（预选）
- 点击"Select"按钮前的状态
- 用于教程第2步（托管计划）

### 3. **function-create.png** - 基础选项卡
- **资源组**: `rg-aoai-realtime-portal-jpe`
- **Function App 名称**: `func-realtime-portal-jpe01`
- **区域**: Japan East
- **运行时堆栈**: Python
- **版本**: 3.13
- **实例大小**: 2048 MB（默认）
- 用于教程第3步（基础配置）

### 4. **storage-auto.png** - 存储选项卡
- 存储账户名自动生成: `rgaoairealtimeporta8998`
- 显示"(新)自动创建"
- 用于教程第4步（存储 - 无需手动创建）

### 5. **monitoring-tab.png** - 监控选项卡
- Application Insights: **是** (启用)
- 自动生成资源名: `func-realtime-portal-jpe01`
- 用于教程第5步（监控配置）

### 6. **review-create.png** - 检查 + 创建选项卡
- 验证所有配置：
  - Python 3.13 ✓
  - Japan East ✓
  - 存储账户已显示 ✓
  - RG `rg-aoai-realtime-portal-jpe` ✓
- 用于教程第6步（部署前最终检查）

### 7. **function-create-complete.png** - 部署完成
- "Your deployment is complete" 通知
- 可以选择 "Go to resource"
- 用于教程步骤 2（创建完成）

### 8. **identity-on.png** - 托管标识配置
- **系统分配的托管标识**: 开启 (On)
- **权限**: Azure 角色分配
- 用于教程步骤 3（启用托管标识）

### 9. **app-settings.png** - 应用设置
- 已配置的应用设置：
  - `AOAI_ENDPOINT` - 已设置（值隐藏）
  - `AOAI_REALTIME_DEPLOYMENT` - 已设置（值隐藏）
  - `APPLICATIONINSIGHTS_CONNECTION_STRING` - 自动设置
  - `AzureWebJobsStorage` - 自动设置
  - `DEPLOYMENT_STORAGE_CONNECTION_STRING` - 自动设置
- 用于教程步骤 4（应用设置配置）

### 10. **function-url.png** - 获取函数 URL
- `realtime_access` 的 **Get function URL** 按钮
- 未打开 URL 对话框，因此截图不包含 Function Key
- 用于教程步骤 7（获取实际 URL）

### 11. **cors.png** - CORS 配置
- **Allowed Origins**: `https://nice-bay-0a60d2200.7.azurestaticapps.net`、`http://localhost:8000`
- 用于教程步骤 8（允许浏览器调用）

### 12. **function-test.png** - 测试与运行
- Test/Run 面板，Body 为 `{"voice": "alloy"}`
- 仅显示请求输入，不显示包含临时令牌的响应
- 用于教程步骤 9（门户内验证）

### 13. **web-demo.png** - 浏览器演示画面
- 本地 `http://localhost:8000` 打开的实时语音演示页
- Function API URL 已填写，Function Key 已遮蔽
- 用于教程步骤 9（浏览器验证）

## 配置数据参考

### 新创建的资源
| 资源 | 名称 | 位置 | 说明 |
|------|------|------|------|
| Resource Group | `rg-aoai-realtime-portal-jpe` | Japan East | 新建 |
| Function App | `func-realtime-portal-jpe01` | Japan East | Flex Consumption, Python 3.13 |
| Storage Account | `rgaoairealtimeporta8998` | Japan East | 自动创建 |
| Application Insights | `func-realtime-portal-jpe01` | Japan East | 自动创建 |

### 应用设置配置
| 键 | 值 | 说明 |
|-----|-----|------|
| `AOAI_ENDPOINT` | `https://aoai-realtime-test01.openai.azure.com/` | Azure OpenAI 端点 |
| `AOAI_REALTIME_DEPLOYMENT` | `gpt-realtime-2.1-mini` | 部署模型名称 |
| `AzureWebJobsStorage` | (自动) | Function App 创建时自动配置，不修改 |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | (自动) | Application Insights 连接 |

### Azure OpenAI RBAC 配置
- **Azure OpenAI 资源**: `aoai-realtime-test01`
- **资源组**: `rg-cloud-migration-copilot`
- **角色**: `Cognitive Services OpenAI User`
- **分配给**: `func-realtime-portal-jpe01` 系统托管标识

教程仅将托管标识用于 Azure OpenAI 认证。Function App 存储继续使用 Portal 自动创建的默认配置。

---

## 截图生成信息

- **日期**: 2026-08-25
- **Azure CLI 版本**: 2.89.1
- **门户地址**: portal.azure.com
- **用户**: admin@M365CPI16988021.onmicrosoft.com
- **订阅**: ME-M365CPI16988021-minghaoli-1
- **租户**: Contoso (M365CPI16988021.onmicrosoft.com)

## 教程文档映射

这些截图用于填充 `docs/azure-functions-portal-ja.md` 中的以下占位符：

```yaml
步骤 2: 创建 Function App
  - ![搜索 Function App](../images/function-portal/search.png)
  - ![选择 Flex Consumption](../images/function-portal/hosting-plan.png)
  - ![基本 tab](../images/function-portal/function-create.png)
  - ![存储 tab (自动创建)](../images/function-portal/storage-auto.png)
  - ![监控 tab](../images/function-portal/monitoring-tab.png)
  - ![审查并创建 tab](../images/function-portal/review-create.png)
  - ![创建完成](../images/function-portal/function-create-complete.png)

步骤 3-4: 认证与应用设置
  - ![启用托管标识](../images/function-portal/identity-on.png)
  - ![应用设置](../images/function-portal/app-settings.png)

步骤 7-9: URL、CORS 与验证
  - ![获取函数 URL](../images/function-portal/function-url.png)
  - ![CORS 配置](../images/function-portal/cors.png)
  - ![测试与运行](../images/function-portal/function-test.png)
  - ![浏览器演示](../images/function-portal/web-demo.png)
```

---

**完成状态**:
- [x] 部署代码 (`func azure functionapp publish`)
- [x] 启用托管标识并分配 Azure OpenAI 角色
- [x] 配置应用设置
- [x] 检索函数 URL 与密钥
- [x] 配置 CORS
- [x] 测试函数（返回 `ephemeral_token` 与 `webrtc_url`）
- [x] 截图 Web 演示
- [x] 更新教程文档
