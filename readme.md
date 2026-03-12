# Token-2022 Transfer Hook

基于 Solana Anchor 的 SPL Token-2022 示例项目，当前实现了三种 mint extension 的组合：

- `TransferHook`
- `PausableConfig`
- `PermanentDelegate`

项目核心目标是对 Token-2022 转账做白名单校验，并验证暂停、恢复、永久代理转账/销毁等能力。

## 当前状态

- `transfer_hook` Program ID: `5LMLujHtNx4VARPXPAUveyRVoMbhmQyM36sasbieoJLw`
- `whitelist_manager` Program ID: `CYowkEpLGViioLpF1QcnS8ZJXi1GUtwPNVCZ2PnkD2bj`
- Anchor 版本: `0.32.1`
- Token Program: `TOKEN_2022_PROGRAM_ID`
- 默认网络配置: devnet

## 功能特性

- `TransferHook`: Token-2022 转账时自动回调本程序执行白名单校验
- 双边白名单校验: 发送方 ATA 和接收方 ATA 都必须在白名单中
- 独立白名单程序: 白名单管理从 `transfer-hook` 中拆分到 `whitelist-manager`
- 多 mint 复用: 多个 mint 可以绑定同一个共享白名单 PDA
- `PausableConfig`: 支持暂停与恢复 token 转账
- `PermanentDelegate`: 永久代理可以在没有 owner approval 的情况下执行转账和销毁
- `MintTo`: 迁移脚本可创建新 mint，并输出 deployment manifest

## 当前白名单设计

当前白名单由独立程序 `whitelist-manager` 负责维护。

共享白名单 PDA 规则：

- program: `whitelist_manager`
- seeds: `["white_list", authority]`
- 同一个 authority 名下的多个 mint 可以共享同一个白名单账户
- 白名单存储的是 token account 地址，而不是 wallet owner

这意味着：

- `GLUSD`、`GLSGD` 等通过当前脚本创建的 mint 可以共用一个白名单
- 白名单检查针对的是 `source_token` 和 `destination_token` 两个 ATA
- 白名单的增删改不再需要修改 `transfer-hook` 程序本身

## 合约指令

### `transfer-hook`

1. `initialize_extra_account_meta_list`
   为指定 mint 初始化 `ExtraAccountMetaList`，并把外部 `white_list` 账户登记为额外账户。
2. `transfer_hook`
   在 Token-2022 转账过程中被调用，检查发送方和接收方 ATA 是否都在白名单中。

### `whitelist-manager`

1. `initialize_whitelist`
   初始化某个 authority 对应的共享白名单 PDA。
2. `add_to_whitelist`
   添加一个 token account 到共享白名单。
3. `remove_from_whitelist`
   从共享白名单移除一个 token account。

## 项目结构

```text
projectc-token-2022/
├── Anchor.toml
├── Cargo.toml
├── package.json
├── migrations/
│   └── deploy.ts
├── programs/
│   ├── transfer-hook/
│   │   └── src/lib.rs
│   └── whitelist-manager/
│       └── src/lib.rs
├── deployments/
│   └── *.json
└── tests/
    └── transfer-hook.ts
```

## 环境要求

- Rust stable
- Solana CLI
- Anchor CLI
- Node.js
- `pnpm` 或 `npm`

## 安装依赖

```bash
pnpm install
```

如果你使用 npm，也可以：

```bash
npm install
```

## 构建

```bash
anchor build
```

## 部署与迁移

当前推荐把“程序部署”和“mint 初始化”分开执行。

### 1. 部署程序

```bash
anchor build
anchor deploy --program-name whitelist_manager
anchor deploy --program-name transfer_hook
```

作用：

- 部署 `whitelist-manager`
- 部署 `transfer-hook`
- 不会自动创建新的 token mint
- 不会自动初始化白名单成员

### 2. 创建带扩展的 token mint，并绑定共享白名单

```bash
anchor run deploy
```

作用：

- 运行 `migrations/deploy.ts`
- 调用 `whitelist_manager.initialize_whitelist`
- 创建新的 `GLUSD` / `GLSGD`
- 为 mint 初始化：
  - `TransferHook`
  - `PausableConfig`
  - `PermanentDelegate`
- 创建 treasury ATA
- 初始化 `ExtraAccountMetaList`
- 把同一个共享 `whiteList` 账户绑定给多个 mint
- 将部署者 treasury ATA 加入共享白名单
- 生成 `deployments/*.json` manifest

如果要在部署时额外加入白名单钱包：

```bash
WHITELIST_OWNERS=addr1,addr2,addr3 anchor run deploy
```

这里传入的是 wallet 地址，脚本会自动为每个 mint 创建对应 ATA，并把这些 ATA 加入共享白名单。

## 迁移脚本产物

每次执行 `anchor run deploy` 后，会在 `deployments/` 下写入一个新的 manifest，包含：

- `programId`
- `mint`
- `pauseAuthority`
- `permanentDelegate`
- `treasuryTokenAccount`
- `extraAccountMetaList`
- `whiteList`

## 测试

当前主测试文件是：

- `tests/transfer-hook.ts`

覆盖内容：

- 创建带三种 extension 的 mint
- 初始化共享白名单
- 初始化两个 mint 的 token account 和 mint supply
- 初始化 transfer hook 元数据，并让多个 mint 复用同一个白名单
- 通过 `whitelist-manager` 添加/移除白名单
- 双边白名单转账成功/失败
- pause / resume
- permanent delegate 直接转账
- permanent delegate 直接 burn

### 运行全部测试

```bash
anchor test --skip-local-validator --skip-build --skip-deploy --run tests/transfer-hook.ts
```

注意：

- `Anchor.toml` 中定义了自定义 `test` script
- 执行 `anchor test` 时，Anchor 会运行该脚本
- 当前脚本会跑 `tests/**/*.ts`

### 只运行单个测试文件

如果你只想跑 `tests/transfer-hook.ts`，建议直接用 `ts-mocha`：

```bash
ANCHOR_PROVIDER_URL="https://devnet.helius-rpc.com/?api-key=YOUR_API_KEY" \
ANCHOR_WALLET="$HOME/.config/solana/id.json" \
pnpm ts-mocha -p ./tsconfig.json -t 1000000 tests/transfer-hook.ts
```

如果你要复用已部署的 devnet 程序，也可以：

```bash
anchor test --skip-local-validator --skip-build --skip-deploy
```

## 典型使用流程

1. `anchor build`
2. `anchor deploy --program-name whitelist_manager`
3. `anchor deploy --program-name transfer_hook`
4. `anchor run deploy`
5. 读取最新 `deployments/*.json` 获取新 mint 地址和共享 `whiteList`
6. 后续通过 `whitelist-manager` 调用 `add_to_whitelist`
7. 对白名单中的 ATA 执行转账
8. 如有需要，调用 Token-2022 的 pause / resume

## 监听建议

如果你要开发链上监听服务，建议同时监听：

- `transfer_hook` 的 `logsSubscribe`
- `whitelist_manager` 的 `logsSubscribe`
- 目标 mint 地址的 `logsSubscribe`
- 再通过 `getTransaction(signature)` 做完整交易解析

建议落地的事件类型：

- `Mint`
- `WhitelistAdded`
- `WhitelistRemoved`
- `TransferSucceeded`
- `TransferRejected`
- `Paused`
- `Resumed`
- `BurnedByPermanentDelegate`

## 生产注意事项

当前版本不建议直接按正式生产资产方案上线，主要原因：

- 白名单按 authority 共享，而不是按 mint 隔离
- 白名单存储为单个 `Vec<Pubkey>`
- `mint authority`、`pause authority`、`permanent delegate` 都默认绑在 deployer 钱包

如果需要走生产化路线，建议下一步至少做：

- 支持按 mint 隔离白名单，或增加 mint -> policy 配置层
- 将关键权限迁到多签
- 重构白名单存储，避免单账户无限增长

## License

MIT
