# Token-2022 Transfer Hook + Stablecoin Ramp

基于 Solana Anchor 的 Token-2022 业务示例，当前包含四个独立 program：

- `transfer-hook`
- `whitelist-manager`
- `business-id-factory`
- `stablecoin-ramp`

这套实现同时覆盖两类能力：

- Token-2022 转账白名单控制
- 稳定币 on-ramp / off-ramp 业务流转与业务 ID 生成

## 当前 Program ID

- `transfer_hook`: `BPu1HGsLmA3PEPW4rCW7fUYYKPNQ1vAPWytvBwr5nuM3`
- `whitelist_manager`: `63YybmV5S1uZdPoXRCUHP5LR34maufSGW4bNaT2GmLMj`
- `business_id_factory`: `35y1BTgc6QzvGYL6raYNJJf6j136ZfQcssWHKKr8rCRf`
- `stablecoin_ramp`: `7Yh27as26FVuh5Hqeq9EpwyKUukiu5RKcgtPsqXrEVeg`

## 架构说明

### 1. `whitelist-manager`

负责维护共享白名单 PDA：

- seeds: `["white_list", authority]`
- 可被多个 mint 复用
- 当前白名单既存 wallet pubkey，也存 token account pubkey

用途分两类：

- `stablecoin-ramp` 校验 wallet 是否允许发起 on/off ramp
- `transfer-hook` 校验 source ATA / destination ATA 是否允许转账

### 2. `transfer-hook`

用于 Token-2022 的转账回调校验：

- 每个 mint 都会初始化 `ExtraAccountMetaList`
- 额外依赖外部共享 `white_list` 账户
- 转账时要求 source ATA 和 destination ATA 同时在白名单中

### 3. `business-id-factory`

用于生成业务 ID。

当前逻辑：

- 维护 `FactoryState`
- 按 `日期 + token symbol + request type` 递增序列
- 生成格式：`YYYYMMDDHHMMSS + SYMBOL + ONRAMP/OFFRAMP + sequence`
- `BusinessIdRecord` 现在是固定 PDA：`["business-id-record"]`
- 每次生成新业务号时，都会覆盖重写同一个 `BusinessIdRecord`

注意：

- `BusinessIdRecord` 只代表“最近一次生成的业务 ID”
- 历史业务号不保存在这个账户中
- 历史业务号要看 `stablecoin-ramp` 的 `RampRequest.business_id`

### 4. `stablecoin-ramp`

用于 on-ramp / off-ramp 请求流转。

主要能力：

- 初始化全局配置
- 注册可用 mint
- 建立每个 mint 对应的 vault
- 用户发起 `request_on_ramp` / `request_off_ramp`
- 管理员审批 / 拒绝
- 管理员直接 `instant_on_ramp`

业务 ID 生成方式：

- `stablecoin-ramp` 内部会 CPI 调 `business-id-factory.reserve_business_id`
- 然后读取固定 `BusinessIdRecord.ref_id`
- 再把该值写入每条 `RampRequest.business_id`

这意味着：

- 客户端不需要单独先调用 `business-id-factory`
- 客户端也不需要创建随机的 `business_id_record` 账户
- 但链上历史仍然以 `RampRequest` 为准，不是 `BusinessIdRecord`

## 项目结构

```text
projectc-token-2022/
├── Anchor.toml
├── Cargo.toml
├── package.json
├── migrations/
│   └── deploy.ts
├── programs/
│   ├── business-id-factory/
│   ├── stablecoin-ramp/
│   ├── transfer-hook/
│   └── whitelist-manager/
├── deployments/
│   └── *.json
└── tests/
    ├── stablecoin-ramp.ts
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

## 构建

```bash
anchor build
```

## 部署流程

### 1. 部署四个 program

```bash
anchor build
anchor deploy --program-name whitelist_manager
anchor deploy --program-name business_id_factory
anchor deploy --program-name stablecoin_ramp
anchor deploy --program-name transfer_hook
```

### 2. 运行 migration

```bash
anchor migrate
```

当前 [migrations/deploy.ts](/usr/src/rust/projectc-token-2022/migrations/deploy.ts) 会执行这些动作：

- 初始化共享白名单
- 把部署者 wallet 加入 wallet 白名单
- 把 `WHITELIST_OWNERS` 中的钱包加入 wallet 白名单
- 初始化 `business-id-factory`
- 初始化 `stablecoin-ramp` config
- 创建 `GLUSD` / `GLSGD` 两个 Token-2022 mint
- 为每个 mint 初始化：
  - `TransferHook`
  - `PausableConfig`
  - `PermanentDelegate`
- 为每个 mint 初始化 `ExtraAccountMetaList`
- 为每个 mint 在 `stablecoin-ramp` 注册 `TokenConfig` 和 `vault`
- 为白名单钱包自动创建对应 ATA，并把这些 ATA 加入 transfer-hook 白名单
- 输出 `deployments/*.json` manifest

如果你想在迁移时附带额外白名单钱包：

```bash
WHITELIST_OWNERS=addr1,addr2,addr3 anchor migrate
```

这里传的是 wallet 地址，不是 ATA。脚本会自动：

- 把 wallet 地址加入 ramp 白名单
- 为这些 wallet 创建对应 ATA
- 把 ATA 加入 transfer-hook 白名单

## Migration 输出

每次执行 `anchor migrate` 后，`deployments/*.json` 会记录：

- 四个 program 地址
- 共享 `whiteList`
- `factoryState`
- 固定 `businessIdRecord`
- `rampConfig`
- `vaultAuthority`
- 每个 mint 的：
  - mint 地址
  - treasury ATA
  - extra account meta list
  - ramp token config
  - ramp vault

## 测试

当前有两个集成测试文件：

- `tests/transfer-hook.ts`
- `tests/stablecoin-ramp.ts`

### `tests/transfer-hook.ts`

覆盖：

- 共享白名单初始化
- 多 mint 复用同一白名单
- transfer hook 白名单校验
- pause / resume
- permanent delegate transfer / burn

### `tests/stablecoin-ramp.ts`

覆盖：

- 初始化 whitelist / business-id-factory / stablecoin-ramp config
- 注册 mint 并为 ramp vault 注入流动性
- `request_on_ramp` 内部 CPI 调业务 ID 工厂
- `approve_on_ramp` 放币到用户 ATA
- `request_off_ramp` 内部再次生成业务 ID
- 固定 `BusinessIdRecord` 被覆盖
- 旧 `RampRequest.business_id` 仍然保留历史业务号
- `approve_off_ramp` 对自发行币执行 burn

### 运行全部测试

```bash
anchor test --skip-local-validator --skip-build --skip-deploy
```

### 只运行 ramp 测试

```bash
anchor test --skip-local-validator --skip-build --skip-deploy --run tests/stablecoin-ramp.ts
```

### 只运行 transfer-hook 测试

```bash
anchor test --skip-local-validator --skip-build --skip-deploy --run tests/transfer-hook.ts
```

## Stablecoin Ramp 使用流程

### On-ramp

1. 客户端准备一个新的 `request` 账户
2. 调用 `stablecoin-ramp.request_on_ramp(amount)`
3. 程序内部 CPI 调 `business-id-factory.reserve_business_id`
4. 固定 `BusinessIdRecord` 被更新为最新 `ref_id`
5. `RampRequest.business_id` 保存这次请求对应的业务号
6. 管理员调用 `approve_on_ramp` 或 `reject_on_ramp`

### Instant on-ramp

1. 管理员调用 `instant_on_ramp(amount)`
2. 程序内部生成业务号
3. 直接从 vault 放币到用户 ATA
4. `RampRequest` 直接记为 `RequestApproved`

### Off-ramp

1. 用户调用 `request_off_ramp(amount)`
2. 程序内部生成新的业务号
3. 用户 token 先转入 vault
4. 管理员调用 `approve_off_ramp` 或 `reject_off_ramp`
5. 若 `is_self_issued = true`，审批时对 vault 中对应数量执行 burn

## 生产注意事项

当前版本更偏向业务流程原型，不建议直接按正式生产资产上线，主要原因：

- `BusinessIdRecord` 是固定 PDA，只保存最近一次业务号
- `FactoryState` 使用单账户 `Vec` 维护计数器，长期增长需要扩容策略
- `whitelist-manager` 仍是单账户 `Vec<Pubkey>` 结构
- `mint authority`、`pause authority`、`permanent delegate`、`ramp authority` 默认都是 deployer

如果要生产化，建议至少补这几项：

- 多签管理关键 authority
- 为业务 ID 工厂做计数器分片或 `realloc` 方案
- 给 ramp 请求和业务号建立更完整的审计索引
- 明确区分 wallet 白名单和 token account 白名单的治理流程

## License

MIT
