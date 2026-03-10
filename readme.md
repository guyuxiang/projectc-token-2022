# Token-2022 Transfer Hook

基于 Solana Anchor 的 SPL Token-2022 示例项目，当前实现了三种 mint extension 的组合：

- `TransferHook`
- `PausableConfig`
- `PermanentDelegate`

项目核心目标是对 Token-2022 转账做白名单校验，并验证暂停、恢复、永久代理转账/销毁等能力。

## 当前状态

- Program ID: `G9wSn2sj6Ki5gc4D7AXAqgrPQdijGE1keXHKpMQFCdak`
- Anchor 版本: `0.32.1`
- Token Program: `TOKEN_2022_PROGRAM_ID`
- 默认网络配置: devnet

## 功能特性

- `TransferHook`: Token-2022 转账时自动回调本程序执行白名单校验
- 双边白名单校验: 发送方 ATA 和接收方 ATA 都必须在白名单中
- `PausableConfig`: 支持暂停与恢复 token 转账
- `PermanentDelegate`: 永久代理可以在没有 owner approval 的情况下执行转账和销毁
- `MintTo`: 迁移脚本可创建新 mint，并输出 deployment manifest

## 当前白名单设计

当前白名单是一个共享 PDA：

- seeds: `["white_list"]`
- 所有 mint 共享同一个白名单账户
- 白名单存储的是 token account 地址，而不是 wallet owner

这意味着：

- `GLUSD`、`GLSGD` 等通过当前脚本创建的 mint 共用一个白名单
- 白名单检查针对的是 `source_token` 和 `destination_token` 两个 ATA
- 当前设计适合 PoC / 联调，不适合大规模生产场景

## 合约指令

1. `initialize_extra_account_meta_list`
   为指定 mint 初始化 `ExtraAccountMetaList`，并在需要时初始化共享 `white_list` PDA。
2. `transfer_hook`
   在 Token-2022 转账过程中被调用，检查发送方和接收方 ATA 是否都在白名单中。
3. `add_to_whitelist`
   添加一个 token account 到共享白名单。
4. `remove_from_whitelist`
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
│   └── transfer-hook/
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

这两个命令职责不同：

### 1. 部署程序

```bash
anchor deploy
```

作用：

- 把 `programs/transfer-hook/src/lib.rs` 编译出来的程序部署到链上
- 不会自动创建新的 token mint

### 2. 创建带扩展的 token mint

```bash
anchor migrate
```

作用：

- 运行 `migrations/deploy.ts`
- 创建新的 `GLUSD` / `GLSGD`
- 为 mint 初始化：
  - `TransferHook`
  - `PausableConfig`
  - `PermanentDelegate`
- 创建 treasury ATA
- 初始化 `ExtraAccountMetaList`
- 将部署者 treasury ATA 加入白名单
- 生成 `deployments/*.json` manifest

## 迁移脚本产物

每次执行 `anchor migrate` 后，会在 `deployments/` 下写入一个新的 manifest，包含：

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
- 初始化 token account 和 mint supply
- 初始化 transfer hook 元数据
- 添加/移除白名单
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
2. `anchor deploy`
3. `anchor migrate`
4. 读取最新 `deployments/*.json` 获取新 mint 地址
5. 调用 `add_to_whitelist`
6. 对白名单中的 ATA 执行转账
7. 如有需要，调用 Token-2022 的 pause / resume

## 监听建议

如果你要开发链上监听服务，建议同时监听：

- 本程序 `programId` 的 `logsSubscribe`
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

- 白名单是共享 PDA，不按 mint 隔离
- 白名单存储为单个 `Vec<Pubkey>`
- `mint authority`、`pause authority`、`permanent delegate` 都默认绑在 deployer 钱包

如果需要走生产化路线，建议下一步至少做：

- 按 mint 隔离白名单
- 将关键权限迁到多签
- 重构白名单存储，避免单账户无限增长

## License

MIT
