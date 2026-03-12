// Migrations are an early feature. Currently, they're nothing more than this
// single deploy script that's invoked from the CLI, injecting a provider
// configured from the workspace's Anchor.toml.

import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getMintLen,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import fs from "fs";
import path from "path";

const TOKEN_CONFIGS = [
  { name: "Global USD", symbol: "GLUSD", decimals: 6, initialSupplyUi: 0 },
  { name: "Global SGD", symbol: "GLSGD", decimals: 6, initialSupplyUi: 0 },
];

function parseWhitelistOwners() {
  const raw = process.env.WHITELIST_OWNERS ?? "";
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new PublicKey(value));
}

async function accountExists(connection: any, pubkey: PublicKey) {
  return (await connection.getAccountInfo(pubkey)) !== null;
}

async function ensureAssociatedTokenAccount(
  connection: any,
  payer: any,
  owner: PublicKey,
  mint: PublicKey,
  instructions: any[]
) {
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  if (!(await accountExists(connection, ata))) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        owner,
        mint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  return ata;
}

async function createTransferHookMint(
  provider: any,
  program: any,
  whitelistProgram: any,
  tokenConfig: any,
  whitelistOwners: PublicKey[],
  whiteList: PublicKey
) {
  const connection = provider.connection;
  const payer = provider.wallet.payer;
  // 生成新密钥对作为 mint 地址
  const mint = Keypair.generate();
  const mintExtensions = [
    ExtensionType.TransferHook,
    ExtensionType.PausableConfig,
    ExtensionType.PermanentDelegate,
  ];
  const mintLen = getMintLen(mintExtensions);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  // 交易包含 3 个指令:
  const createMintTx = new Transaction().add(
    // 1. 创建账户
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // 2. 初始化 Transfer Hook扩展
    createInitializeTransferHookInstruction(
      mint.publicKey,
      payer.publicKey,
      program.programId,
      TOKEN_2022_PROGRAM_ID
    ),
    // 3. 初始化 Pausable 扩展
    createInitializePausableConfigInstruction(
      mint.publicKey,
      payer.publicKey,
      TOKEN_2022_PROGRAM_ID
    ),
    // 4. 初始化 Permanent Delegate 扩展
    createInitializePermanentDelegateInstruction(
      mint.publicKey,
      payer.publicKey,
      TOKEN_2022_PROGRAM_ID
    ),
    // 5. 初始化 Mint
    createInitializeMintInstruction(
      mint.publicKey,
      tokenConfig.decimals,
      payer.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID
    )
  );

  await provider.sendAndConfirm(createMintTx, [mint]);

  const treasuryInstructions: any[] = [];
  const treasuryAta = await ensureAssociatedTokenAccount(
    connection,
    payer,
    payer.publicKey,
    mint.publicKey,
    treasuryInstructions
  );

  const baseUnits = BigInt(10) ** BigInt(tokenConfig.decimals);
  const initialSupply = BigInt(tokenConfig.initialSupplyUi) * baseUnits;

  if (initialSupply > 0n) {
    treasuryInstructions.push(
      createMintToInstruction(
        mint.publicKey,
        treasuryAta,
        payer.publicKey,
        initialSupply,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  if (treasuryInstructions.length > 0) {
    await provider.sendAndConfirm(
      new Transaction().add(...treasuryInstructions)
    );
  }

  // 初始化 ExtraAccountMetaList
  //   - 为 Transfer Hook 初始化额外账户元数据列表
  //   - 这允许在转账时执行自定义逻辑（白名单检查）
  await program.methods
    .initializeExtraAccountMetaList()
    .accounts({
      mint: mint.publicKey,
      whiteList,
    })
    .rpc();

  // 将部署者 + 白名单所有者都添加到白名单
  const whitelistTokenAccounts = [];
  const ownersToWhitelist = [payer.publicKey, ...whitelistOwners];

  for (const owner of ownersToWhitelist) {
    // 1. 创建 ATA (如果不存在)
    // 2. 调用程序的 addToWhitelist 方法
    const instructions: any[] = [];
    const tokenAccount = await ensureAssociatedTokenAccount(
      connection,
      payer,
      owner,
      mint.publicKey,
      instructions
    );

    if (instructions.length > 0) {
      await provider.sendAndConfirm(new Transaction().add(...instructions));
    }

    await whitelistProgram.methods
      .addToWhitelist()
      .accounts({
        newAccount: tokenAccount,
        authority: payer.publicKey,
        whiteList,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    whitelistTokenAccounts.push({
      owner: owner.toBase58(),
      tokenAccount: tokenAccount.toBase58(),
    });
  }

  // 存储额外账户元数据的 PDA
  const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()],
    program.programId
  );

  return {
    name: tokenConfig.name,
    symbol: tokenConfig.symbol,
    decimals: tokenConfig.decimals,
    initialSupplyUi: tokenConfig.initialSupplyUi,
    mint: mint.publicKey.toBase58(),
    pauseAuthority: payer.publicKey.toBase58(),
    permanentDelegate: payer.publicKey.toBase58(),
    treasuryTokenAccount: treasuryAta.toBase58(),
    extraAccountMetaList: extraAccountMetaList.toBase58(),
    whiteList: whiteList.toBase58(),
    whitelistTokenAccounts,
  };
}

function writeDeploymentManifest(
  clusterName: string,
  programId: string,
  deployedTokens: any[]
) {
  const outputDir = path.join(process.cwd(), "deployments");
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(outputDir, `${clusterName}-${timestamp}.json`);

  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        cluster: clusterName,
        programId,
        deployedAt: new Date().toISOString(),
        tokens: deployedTokens,
      },
      null,
      2
    )
  );

  return outputPath;
}

module.exports = async (provider: any) => {
  console.log("=== Migration script started ===");
  anchor.setProvider(provider);

  const program = anchor.workspace.TransferHook;
  const whitelistProgram = anchor.workspace.WhitelistManager;
  const clusterName = provider.connection.rpcEndpoint;
  const whitelistOwners = parseWhitelistOwners();
  const [whiteList] = PublicKey.findProgramAddressSync(
    [Buffer.from("white_list"), provider.wallet.publicKey.toBuffer()],
    whitelistProgram.programId
  );

  console.log("Transfer hook program:", program.programId.toBase58());
  console.log("Whitelist manager program:", whitelistProgram.programId.toBase58());
  console.log("Deployer:", provider.wallet.publicKey.toBase58());
  console.log(
    "Whitelist owners:",
    whitelistOwners.length > 0
      ? whitelistOwners.map((owner) => owner.toBase58()).join(", ")
      : "(deployer treasury ATA only)"
  );

  if (!(await accountExists(provider.connection, whiteList))) {
    await whitelistProgram.methods
      .initializeWhitelist()
      .accounts({
        authority: provider.wallet.publicKey,
        whiteList,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  const deployedTokens = [];
  for (const tokenConfig of TOKEN_CONFIGS) {
    const token = await createTransferHookMint(
      provider,
      program,
      whitelistProgram,
      tokenConfig,
      whitelistOwners,
      whiteList
    );
    deployedTokens.push(token);

    console.log(`[${token.symbol}] mint: ${token.mint}`);
    console.log(
      `[${token.symbol}] treasury ATA: ${token.treasuryTokenAccount}`
    );
    console.log(
      `[${token.symbol}] extra account meta list: ${token.extraAccountMetaList}`
    );
  }

  const manifestPath = writeDeploymentManifest(
    clusterName.replace(/[^a-zA-Z0-9_-]/g, "_"),
    program.programId.toBase58(),
    deployedTokens
  );

  console.log("Deployment manifest written to:", manifestPath);
  console.log(
    "Note: all mints in this deployment share the same whitelist-manager PDA."
  );
};
