# projectc-oft-solana

这个仓库是 Solana 侧稳定币 OFT 实现。它的目标不是替代你原有的 Token-2022 业务，而是在保留原稳定币 mint 扩展能力的前提下，为它增加一条 `Solana Devnet <-> Sepolia` 的双向跨链通道。

当前实现基于：

- Anchor program `programs/oft`
- LayerZero Solana Endpoint V2
- Native OFT
- burn / mint
- 无 `token_escrow`
- `oft_fee = 0`

这份 README 重点解释：

- 这个仓库在整套跨链系统里负责什么
- Solana 侧 OFT program 的核心账户和组件
- 为什么这里可以兼容原来的扩展 mint
- 一条跨链消息在 Solana 侧的完整执行路径
- 当前工程入口和部署流程

## 1. 项目定位

这个仓库原本就有自己的业务 program：

- `transfer-hook`
- `whitelist-manager`
- `business-id-factory`
- `stablecoin-ramp`

现在又新增了一个专门的跨链 program：

- `oft`

这意味着当前仓库同时承担两件事：

- 保留本地 Token-2022 稳定币业务能力
- 让这枚稳定币可以作为 LayerZero OFT 参与跨链

Solana 侧负责：

- 使用现有 Token-2022 mint 作为跨链资产
- 创建 `oft_store`
- 在 `Solana -> Sepolia` 时 burn
- 在 `Sepolia -> Solana` 时 mint
- 把 mint authority 委托给包含 `oft_store` 的 `1-of-n` multisig

## 2. 核心概念

### 2.1 Native OFT

这里采用的是 `Native OFT`，不是 OFT Adapter。

区别在于：

- Native OFT
  - 直接把本链原生 token 作为跨链资产
  - 源链 burn，目标链 mint
- Adapter
  - 通过 lock / unlock 或 escrow 管理资产
  - 更像“桥接包装层”

你这个项目是自发行稳定币，所以更适合 Native OFT。

### 2.2 `oft_store`

`oft_store` 是 Solana 侧 OFT 的核心 PDA。它可以理解为：

- 这个 OFT 在 Solana 上的“主状态账户”
- 绑定某一枚 `token_mint`
- 存放 admin、pause 状态、精度换算、endpoint program 等配置

在当前实现里：

- `oft_store` 的 seed 是 `["OFT", token_mint]`
- 不再依赖 `token_escrow`

这点和官方默认示例不同，是这次项目定制化的重点。

### 2.3 Peer Config

每个远端链都有一份 peer 配置，里面主要包含：

- 远端 EID
- 远端 peer 地址
- enforced options
- inbound / outbound rate limiter
- fee 配置

当前这套项目里：

- 远端 peer 是 Sepolia 上的 OFT proxy
- fee 固定为 `0`
- 仍保留 peer config 结构，用来承载远端地址和执行参数

### 2.4 Nonce

LayerZero 在接收消息时要维护 path 的 nonce 状态。Solana 侧如果没有初始化 nonce PDA：

- 目标 OApp 无法正确识别和推进 inbound 消息序列
- 消息可能停在协议层

所以 Solana 侧 wiring 不只配 peer，还要初始化 inbound nonce。

### 2.5 Enforced Options

Solana 侧也需要保存对每条远端路径的执行参数，比如：

- 发送到 EVM 时 EVM 接收侧所需 gas
- 如果将来有 compose，还可以区分 send / sendAndCall

它不是“业务参数”，而是 LayerZero 消息执行参数。

## 3. Solana 侧核心组件

### 3.1 `programs/oft`

核心 program 在 [`programs/oft/src/lib.rs`](/Users/guyuxiang/Documents/omnichain/projectc-oft-solana/programs/oft/src/lib.rs)。

主要入口有：

- `init_oft`
- `set_oft_config`
- `set_peer_config`
- `send`
- `lz_receive`
- `lz_receive_types`

### 3.2 `init_oft`

[`init_oft.rs`](/Users/guyuxiang/Documents/omnichain/projectc-oft-solana/programs/oft/src/instructions/init_oft.rs) 负责：

- 创建 `oft_store`
- 绑定目标 `token_mint`
- 设置 `shared_decimals`
- 注册 OApp 到 LayerZero endpoint
- 创建 `lz_receive_types_accounts`

在当前定制版里，最重要的变化是：

- `oft_store` 基于 `token_mint` 推导
- 不再创建也不再依赖 `token_escrow`

### 3.3 `send`

[`send.rs`](/Users/guyuxiang/Documents/omnichain/projectc-oft-solana/programs/oft/src/instructions/send.rs) 是 Solana 源链发送逻辑。

它做的事情是：

1. 检查 pause 状态
2. 根据 decimals / sharedDecimals 做金额换算
3. 检查 rate limiter
4. 从用户 token account 执行 `burn`
5. 通过 LayerZero endpoint 发送消息

这里有两个关键点：

- 本金路径是纯 `burn`
- 由于 `oft_fee = 0`，没有额外 fee 资产路径

### 3.4 `lz_receive`

[`lz_receive.rs`](/Users/guyuxiang/Documents/omnichain/projectc-oft-solana/programs/oft/src/instructions/lz_receive.rs) 是 Solana 目标链接收逻辑。

它做的事情是：

1. 验证 peer 和 sender
2. 调用 endpoint `clear`
3. 把消息里的共享精度金额换回本地精度
4. 检查 inbound / outbound limiter
5. 通过当前 mint authority 执行 `mint_to`
6. 如有 compose，再发送 compose message

这里的核心事实是：

- 接收时真正给用户到账的是一次本地 mint
- 所以 mint authority 必须允许 OFT 路径铸币

## 4. 为什么能兼容原扩展 mint

你原来的稳定币 mint 带有：

- `transfer-hook`
- `pausable`
- `permanent-delegate`

官方示例最初卡住的根因，不是 OFT 理论不支持这些扩展，而是：

- 官方 Native 路径默认仍围绕 `token_escrow`
- 账户布局和初始化方式更偏向标准 token account

现在这套实现之所以能兼容，是因为我们做了两类调整：

### 4.1 移除 Native 模式下的 `token_escrow`

当前设计里：

- Native OFT 本金路径只需要 `burn / mint`
- 不需要 escrow 托管本金

所以程序层把 `token_escrow` 从 Native 路径中移除了。

这样做后：

- 跨链本金不依赖中间托管账户
- 也避免了扩展 token account 初始化上的兼容问题

### 4.2 用 multisig 承接 mint authority

当前要求是：

- mint authority 不直接给某个人
- 也不强制必须只给 `oft_store`
- 而是给一个 `1-of-n` SPL multisig

这个 multisig 里至少包括：

- `oft_store`
- 部署者钱包或额外发行方钱包

这样实现后：

- OFT 接收路径可以 mint
- 原发行方钱包仍然可以继续直接铸币

这就是“跨链可 mint”和“发行方保留铸币能力”同时成立的原因。

## 5. 跨链时序

### 5.1 `Solana -> Sepolia`

1. 用户在 Solana 调用 `send`
2. OFT program 从用户 ATA burn token
3. LayerZero Endpoint 发送消息
4. Sepolia OFT 接收消息
5. EVM 侧 `_credit` 执行
6. Sepolia 上 mint token 给目标地址

### 5.2 `Sepolia -> Solana`

1. 用户在 Sepolia 调用 OFT `send`
2. EVM 侧 `_debit` 执行并 burn
3. LayerZero 发送消息
4. Solana `lz_receive` 收到消息
5. 校验 peer、nonce、path config
6. 根据 mint authority 执行 `mint_to`
7. 用户在 Solana ATA 收到 token

## 6. 关键账户与数据关系

### 6.1 `token_mint`

这是你的原稳定币 mint，本项目不是新建一枚跨链专用 token，而是直接复用这枚 mint。

### 6.2 `oft_store`

记录 OFT 主状态：

- `token_mint`
- `ld2sd_rate`
- `admin`
- `paused`
- `endpoint_program`
- bump

### 6.3 `peer`

按 `["Peer", oft_store, remote_eid]` 派生，记录：

- remote peer address
- enforced options
- limiter
- fee bps

### 6.4 `mintAuthority`

当前链上实际配置为 SPL multisig。它既服务于：

- OFT 接收路径 mint
- 发行方继续铸币

## 7. 工程文件

### 7.1 脚本

- [`deployDevnet.ts`](/Users/guyuxiang/Documents/omnichain/projectc-oft-solana/scripts/layerzero/deployDevnet.ts)
  - 初始化 `oft_store`
  - 创建 multisig
  - 切换 mint / freeze authority
- [`wireDevnetToSepolia.ts`](/Users/guyuxiang/Documents/omnichain/projectc-oft-solana/scripts/layerzero/wireDevnetToSepolia.ts)
  - 初始化 path config
  - 设置 Sepolia peer
  - 设置 enforced options
  - 初始化 inbound nonce
- [`sendDevnetToSepolia.ts`](/Users/guyuxiang/Documents/omnichain/projectc-oft-solana/scripts/layerzero/sendDevnetToSepolia.ts)
  - 发起 Solana -> Sepolia 发送
  - 轮询 EVM 余额验证到账
- [`utils.ts`](/Users/guyuxiang/Documents/omnichain/projectc-oft-solana/scripts/layerzero/utils.ts)
  - 部署文件读写
  - 跨仓 deployment 读取
  - 调用 `hardhat` task

### 7.2 脚本库

- `scripts/layerzero/lib/solanaRuntime.ts`
  - Solana 连接、deployment、优先费和 lookup table
- `scripts/layerzero/lib/nativeOft.ts`
  - Native OFT PDA、quote、send helper
- `scripts/layerzero/lib/sendSolana.ts`
  - 发送流程高层封装
- `scripts/layerzero/lib/multisig.ts`
  - mint authority multisig 创建和校验
- `scripts/layerzero/lib/solanaUtils.ts`
  - 数值换算、authority 校验、graph 解析

### 7.3 部署产物

- `deployments/solana-testnet/OFT.json`

记录：

- `programId`
- `mint`
- `mintAuthority`
- `oftStore`
- `remote`

这个文件既是部署结果，也是后续 wiring / send 的默认输入。

## 8. 实际工程流程

### 8.1 编译

```bash
npm install
anchor build
npm run compile:hardhat
```

### 8.2 部署并初始化 OFT

```bash
SOLANA_MINT=<your_token_2022_mint> \
npm run lz:deploy:devnet
```

这一步会：

1. 复用现有 mint
2. 创建 `oft_store`
3. 创建 `1-of-n` mint authority multisig
4. 把 mint / freeze authority 切到该 multisig
5. 写入本地 deployment 文件

### 8.3 配置通向 Sepolia 的路径

```bash
SEPOLIA_OFT_ADDRESS=<sepolia_proxy> \
npm run lz:wire:sepolia
```

这一步会：

1. 执行 `lz:oft:solana:init-config`
2. 写入 EVM peer
3. 写入 `Solana -> EVM` enforced options
4. 初始化 inbound nonce

### 8.4 从 Solana 发到 Sepolia

```bash
SEPOLIA_RECIPIENT=<evm_receiver> \
AMOUNT=1 \
npm run lz:send:sepolia
```

## 9. 设计取舍

### 9.1 为什么移除 `token_escrow`

因为当前模式是 Native OFT 的 `burn / mint`。对本金路径来说：

- 发送时 burn
- 接收时 mint

既然不做 lock / unlock，本金就不需要 escrow。

### 9.2 为什么 fee 固定为 0

因为当前目标是先把稳定币跨链主路径跑通，而且业务上没有额外 OFT fee 需求。于是：

- `oft_fee = 0`
- 不再引入 fee 托管或提取路径

这样可以让程序结构更清晰，也减少扩展 mint 下不必要的复杂度。

### 9.3 为什么还保留极薄的 Hardhat task 层

当前主逻辑已经迁到 `scripts/layerzero/lib/`。但 `init-config` 这一步仍复用 LayerZero 官方 Hardhat wiring 能力，因为它属于协议层初始化，而不是业务层发送逻辑。  
所以现在 `tasks/` 只保留了跑 `init-config` 所需的最小桥接层。

## 10. 与业务 program 的关系

### 10.1 `transfer-hook`

它仍然负责 Solana 本地 token 转账限制。OFT 只是新增了一条跨链 mint / burn 路径，不会替代本地白名单控制。

### 10.2 `stablecoin-ramp`

它仍然负责出入金业务，不负责 LayerZero 消息协议。

### 10.3 `whitelist-manager`

它仍然是本地权限数据来源，与 OFT 是否发消息没有直接耦合。

换句话说：

- OFT 解决“跨链如何移动”
- 业务 program 解决“本地业务如何治理”

## 11. 常见问题

### 11.1 为什么不是官方原版 `oft_solana`

因为原版 Native 路径仍带有对 `token_escrow` 的结构性依赖，而你的目标是：

- burn / mint
- 无 escrow
- fee = 0
- 兼容扩展 mint

所以这里做了定制版 Native OFT。

### 11.2 为什么还需要 mint authority multisig

因为 `lz_receive` 本质上要调用 `mint_to`。如果没有可用的 mint authority，消息到了也无法到账。

### 11.3 为什么发送脚本要轮询 EVM 余额

因为真正业务结果是目标链到账，不是本地 send 成功。脚本轮询目标余额是为了验证完整跨链闭环，而不是只验证源链 tx 成功。

## 12. 和 EVM 仓库的关系

Solana 侧默认会读取：

- `../projectc-oft-evm/deployments/sepolia/OFT.json`

EVM 侧默认会读取：

- `../projectc-oft-solana/deployments/solana-testnet/OFT.json`

这样两边通过 deployment 文件形成一个稳定的工程闭环：

- 先部署
- 再 wiring
- 再 send

不需要每次手工重复录入所有地址。
