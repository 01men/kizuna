# 提额 / 白名单申请（Quota increase & allowlist requests）

Kizuna 的公开端点有防滥用限额，默认 **每人每分钟 10 次**（公开安装与演示沙箱各自计算）。

- **被限额了？** 等一分钟再试通常就恢复了。落地页会显示剩余等待时间。
- **需要更高额度 / 加入白名单？** 在下面留下信息，我们会把来源 IP 加进 Hub 白名单——**白名单来源完全不受限流约束**。

## 怎么申请

**方式一（推荐）**：开一个 issue，标题带 `[提额]`：

> https://github.com/01men/kizuna/issues/new?labels=quota&title=%5B%E6%8F%90%E9%A2%9D%5D+

请写明三项，缺项会来回确认、耗时更久：

```
1. 用途：          例如「社区机器人每日巡检」「公司内网 Agent 批量接入」
2. 来源出口 IP：    例如 203.0.113.7（或 CIDR：203.0.113.0/24）
3. 联系方式：      邮箱或微信号，便于回访确认
```

**方式二**：直接邮件联系维护者（见仓库 git 提交记录中的作者邮箱 / 或通过 issue 索取）。

## 维护者怎么处理

把来源加进 Hub 设置页的「限流白名单」（`rate_limit_allowlist`），支持单地址与 CIDR：

```json
{ "rate_limit_allowlist": ["203.0.113.7", "10.0.0.0/8", "2001:db8::/32"] }
```

写进 `PUT /api/v1/settings`，即时生效，并在 `config_audit` 留下变更记录。

> ⚠️ 白名单是**完全豁免**（不计数、不限速），只添加你信任的地址；IPv4 / IPv6 均支持，含 `::ffff:` 映射形式的自动归一化。

## 自建 Hub 的话

限额、白名单、提额联系方式都在你自己的管理台「设置」页，无需改代码：

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| `public_install_per_minute` | 10 | 公开安装端点每人每分钟次数 |
| `demo_per_minute` | 10 | 演示沙箱每人每分钟次数 |
| `rate_limit_allowlist` | 空 | 豁免名单（IP / CIDR），最多 200 条 |
| `quota_contact` | 本仓库 issue 地址 | 超限时展示给访客的提额入口 |

也可以整体关掉公开端点：`KIZUNA_PUBLIC_INSTALL=false`。