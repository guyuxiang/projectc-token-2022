# Token 2022 Transfer Hook

基于 Solana Anchor 框架的 SPL Token-2022 Transfer Hook 实现，提供代币转账白名单功能。

## 功能特性

- **Transfer Hook 扩展**: 使用 SPL Token-2022 的 Transfer Hook 接口，在代币转账时执行自定义验证逻辑
- **白名单机制**: 仅允许向白名单中的目标账户转账代币
- **权限控制**: 只有白名单管理员可以添加或管理白名单账户

## 技术栈

- **Solana**: 区块链底层
- **Anchor**: Solana 智能合约框架 (v0.32.1)
- **SPL Token-2022**: Solana 代币标准，支持扩展功能
- **TypeScript**: 测试和客户端代码

## 项目结构

```
projectc-token-2022/
├── Anchor.toml              # Anchor 配置文件
├── Cargo.toml               # Workspace 配置
├── package.json             # Node.js 依赖
├── programs/
│   └── transfer-hook/       # Transfer Hook 智能合约
│       ├── Cargo.toml
│       └── src/lib.rs       # 合约逻辑
└── tests/                   # 测试文件
```

## 核心合约

### 程序 ID
```
DrWbQtYJGtsoRwzKqAbHKHKsCJJfpysudF39GBVFSxub
```

### 指令

1. **initialize_extra_account_meta_list**: 初始化 ExtraAccountMetaList 账户和白名单
2. **transfer_hook**: Transfer Hook 回调，在每次转账时自动执行白名单验证
3. **add_to_whitelist**: 向白名单添加新账户

## 构建与部署

### 前置条件

- Rust (latest stable)
- Solana CLI
- Anchor CLI
- Node.js & pnpm

### 构建合约

```bash
cargo build-spl
```

### 部署

```bash
anchor deploy
```

### 运行测试

```bash
anchor test
# 或
pnpm test
```

## 使用流程

1. **创建支持 Transfer Hook 的代币**: 使用 Token-2022 扩展创建代币，并配置 Transfer Hook 指向本程序
2. **初始化白名单**: 调用 `initialize_extra_account_meta_list` 指令
3. **添加白名单账户**: 使用 `add_to_whitelist` 添加允许接收代币的目标账户
4. **转账**: 只有目标账户在白名单中时，转账才会成功

## 账户结构

### WhiteList PDA
- **Authority**: 白名单管理员公钥
- **WhiteList**: 允许接收代币的目标账户列表

## 注意事项

- 白名单数据存储在链上账户中，扩展可能需要额外的存储费用
- 当前实现将白名单存储在单个账户中，对于大规模项目建议使用外部 PDA 存储

## License

MIT
