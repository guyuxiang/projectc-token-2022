import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
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
  {
    name: "Global USD",
    symbol: "GLUSD",
    decimals: 6,
    initialSupplyUi: 0,
    rampLiquidityUi: 0,
    isSelfIssued: true,
  },
  {
    name: "Global SGD",
    symbol: "GLSGD",
    decimals: 6,
    initialSupplyUi: 0,
    rampLiquidityUi: 0,
    isSelfIssued: true,
  },
];

const WHITE_LIST_SEED = "white_list";
const FACTORY_SEED = "business-id-factory";
const BUSINESS_ID_RECORD_SEED = "business-id-record";
const CONFIG_SEED = "stablecoin-ramp-config";
const TOKEN_CONFIG_SEED = "stablecoin-ramp-token-config";
const VAULT_SEED = "stablecoin-ramp-vault";
const VAULT_AUTHORITY_SEED = "stablecoin-ramp-vault-authority";
const EXTRA_ACCOUNT_METAS_SEED = "extra-account-metas";

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

async function ensureWhitelist(
  provider: any,
  whitelistProgram: any,
  whiteList: PublicKey,
  walletOwners: PublicKey[]
) {
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

  for (const owner of walletOwners) {
    await whitelistProgram.methods
      .addToWhitelist()
      .accounts({
        newAccount: owner,
        authority: provider.wallet.publicKey,
        whiteList,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }
}

async function ensureBusinessIdFactory(
  provider: any,
  factoryProgram: any,
  factoryState: PublicKey
) {
  if (await accountExists(provider.connection, factoryState)) {
    return;
  }

  await factoryProgram.methods
    .initializeFactory()
    .accounts({
      authority: provider.wallet.publicKey,
      factoryState,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

async function ensureRampConfig(
  provider: any,
  rampProgram: any,
  config: PublicKey,
  vaultAuthority: PublicKey,
  businessIdFactoryProgramId: PublicKey,
  whiteList: PublicKey
) {
  if (!(await accountExists(provider.connection, config))) {
    await rampProgram.methods
      .initializeConfig(businessIdFactoryProgramId, whiteList)
      .accounts({
        authority: provider.wallet.publicKey,
        config,
        vaultAuthority,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return;
  }

  await rampProgram.methods
    .updateConfig(businessIdFactoryProgramId, whiteList)
    .accounts({
      authority: provider.wallet.publicKey,
      config,
    })
    .rpc();
}

async function createTransferHookMint(
  provider: any,
  transferHookProgram: any,
  whitelistProgram: any,
  rampProgram: any,
  tokenConfig: any,
  whiteList: PublicKey,
  walletOwners: PublicKey[]
) {
  const connection = provider.connection;
  const payer = provider.wallet.payer;
  const mint = Keypair.generate();
  const mintExtensions = [
    ExtensionType.TransferHook,
    ExtensionType.PausableConfig,
    ExtensionType.PermanentDelegate,
  ];
  const mintLen = getMintLen(mintExtensions);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(
        mint.publicKey,
        payer.publicKey,
        transferHookProgram.programId,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializePausableConfigInstruction(
        mint.publicKey,
        payer.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializePermanentDelegateInstruction(
        mint.publicKey,
        payer.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        mint.publicKey,
        tokenConfig.decimals,
        payer.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID
      )
    ),
    [mint]
  );

  const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
    [Buffer.from(EXTRA_ACCOUNT_METAS_SEED), mint.publicKey.toBuffer()],
    transferHookProgram.programId
  );
  const [rampTokenConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from(TOKEN_CONFIG_SEED), mint.publicKey.toBuffer()],
    rampProgram.programId
  );
  const [rampVault] = PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_SEED), mint.publicKey.toBuffer()],
    rampProgram.programId
  );

  await transferHookProgram.methods
    .initializeExtraAccountMetaList()
    .accounts({
      mint: mint.publicKey,
      whiteList,
    })
    .rpc();

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
  const rampLiquidity = BigInt(tokenConfig.rampLiquidityUi) * baseUnits;

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

  for (const owner of walletOwners) {
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
  }

  await rampProgram.methods
    .registerToken(tokenConfig.symbol, tokenConfig.isSelfIssued)
    .accounts({
      authority: payer.publicKey,
      mint: mint.publicKey,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  if (rampLiquidity > 0n) {
    await rampProgram.methods
      .depositToken(new anchor.BN(rampLiquidity.toString()))
      .accounts({
        authority: payer.publicKey,
        mint: mint.publicKey,
        authorityTokenAccount: treasuryAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  return {
    name: tokenConfig.name,
    symbol: tokenConfig.symbol,
    decimals: tokenConfig.decimals,
    initialSupplyUi: tokenConfig.initialSupplyUi,
    rampLiquidityUi: tokenConfig.rampLiquidityUi,
    isSelfIssued: tokenConfig.isSelfIssued,
    mint: mint.publicKey.toBase58(),
    pauseAuthority: payer.publicKey.toBase58(),
    permanentDelegate: payer.publicKey.toBase58(),
    treasuryTokenAccount: treasuryAta.toBase58(),
    extraAccountMetaList: extraAccountMetaList.toBase58(),
    whiteList: whiteList.toBase58(),
    rampTokenConfig: rampTokenConfig.toBase58(),
    rampVault: rampVault.toBase58(),
  };
}

function writeDeploymentManifest(
  clusterName: string,
  programs: Record<string, string>,
  sharedAccounts: Record<string, string>,
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
        programs,
        sharedAccounts,
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

  const transferHookProgram = anchor.workspace.TransferHook;
  const whitelistProgram = anchor.workspace.WhitelistManager;
  const businessIdFactoryProgram = anchor.workspace.BusinessIdFactory;
  const stablecoinRampProgram = anchor.workspace.StablecoinRamp;
  const clusterName = provider.connection.rpcEndpoint;
  const whitelistOwners = parseWhitelistOwners();
  const walletOwners = [provider.wallet.publicKey, ...whitelistOwners];

  const [whiteList] = PublicKey.findProgramAddressSync(
    [Buffer.from(WHITE_LIST_SEED), provider.wallet.publicKey.toBuffer()],
    whitelistProgram.programId
  );
  const [factoryState] = PublicKey.findProgramAddressSync(
    [Buffer.from(FACTORY_SEED)],
    businessIdFactoryProgram.programId
  );
  const [businessIdRecord] = PublicKey.findProgramAddressSync(
    [Buffer.from(BUSINESS_ID_RECORD_SEED)],
    businessIdFactoryProgram.programId
  );
  const [rampConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from(CONFIG_SEED)],
    stablecoinRampProgram.programId
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_AUTHORITY_SEED)],
    stablecoinRampProgram.programId
  );

  console.log(
    "Transfer hook program:",
    transferHookProgram.programId.toBase58()
  );
  console.log(
    "Whitelist manager program:",
    whitelistProgram.programId.toBase58()
  );
  console.log(
    "Business ID factory program:",
    businessIdFactoryProgram.programId.toBase58()
  );
  console.log(
    "Stablecoin ramp program:",
    stablecoinRampProgram.programId.toBase58()
  );
  console.log("Deployer:", provider.wallet.publicKey.toBase58());
  console.log(
    "Whitelist owners:",
    whitelistOwners.length > 0
      ? whitelistOwners.map((owner) => owner.toBase58()).join(", ")
      : "(deployer only)"
  );

  await ensureWhitelist(provider, whitelistProgram, whiteList, walletOwners);
  await ensureBusinessIdFactory(
    provider,
    businessIdFactoryProgram,
    factoryState
  );
  await ensureRampConfig(
    provider,
    stablecoinRampProgram,
    rampConfig,
    vaultAuthority,
    businessIdFactoryProgram.programId,
    whiteList
  );

  const deployedTokens = [];
  for (const tokenConfig of TOKEN_CONFIGS) {
    const token = await createTransferHookMint(
      provider,
      transferHookProgram,
      whitelistProgram,
      stablecoinRampProgram,
      tokenConfig,
      whiteList,
      walletOwners
    );
    deployedTokens.push(token);
    console.log(`[${token.symbol}] mint: ${token.mint}`);
    console.log(
      `[${token.symbol}] treasury ATA: ${token.treasuryTokenAccount}`
    );
    console.log(`[${token.symbol}] ramp vault: ${token.rampVault}`);
  }

  const manifestPath = writeDeploymentManifest(
    clusterName.replace(/[^a-zA-Z0-9_-]/g, "_"),
    {
      transferHook: transferHookProgram.programId.toBase58(),
      whitelistManager: whitelistProgram.programId.toBase58(),
      businessIdFactory: businessIdFactoryProgram.programId.toBase58(),
      stablecoinRamp: stablecoinRampProgram.programId.toBase58(),
    },
    {
      whiteList: whiteList.toBase58(),
      factoryState: factoryState.toBase58(),
      businessIdRecord: businessIdRecord.toBase58(),
      rampConfig: rampConfig.toBase58(),
      vaultAuthority: vaultAuthority.toBase58(),
    },
    deployedTokens
  );

  console.log("Deployment manifest written to:", manifestPath);
  console.log(
    "Note: whitelist_manager now stores both wallet addresses and token accounts."
  );
};
