import * as anchor from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getMintLen,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';

const TOKEN_CONFIGS = [
  { name: 'Global USD', symbol: 'GLUSD', decimals: 6, initialSupplyUi: 0 },
  { name: 'Global SGD', symbol: 'GLSGD', decimals: 6, initialSupplyUi: 0 },
];

function parseWhitelistOwners() {
  const raw = process.env.WHITELIST_OWNERS ?? '';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new PublicKey(value));
}

async function accountExists(connection: any, pubkey: PublicKey) {
  return (await connection.getAccountInfo(pubkey)) !== null;
}

async function ensureAssociatedTokenAccount(connection: any, payer: any, owner: PublicKey, mint: PublicKey, instructions: any[]) {
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  if (!(await accountExists(connection, ata))) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        owner,
        mint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }

  return ata;
}

async function createTransferHookMint(provider: any, program: any, tokenConfig: any, whitelistOwners: PublicKey[]) {
  const connection = provider.connection;
  const payer = provider.wallet.payer;
  const mint = Keypair.generate();
  const mintLen = getMintLen([ExtensionType.TransferHook]);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const createMintTx = new Transaction().add(
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
      program.programId,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMintInstruction(
      mint.publicKey,
      tokenConfig.decimals,
      payer.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID,
    ),
  );

  await provider.sendAndConfirm(createMintTx, [mint]);

  const treasuryInstructions: any[] = [];
  const treasuryAta = await ensureAssociatedTokenAccount(
    connection,
    payer,
    payer.publicKey,
    mint.publicKey,
    treasuryInstructions,
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
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }

  if (treasuryInstructions.length > 0) {
    await provider.sendAndConfirm(new Transaction().add(...treasuryInstructions));
  }

  try {
    await program.methods
      .initializeExtraAccountMetaList()
      .accounts({
        mint: mint.publicKey,
      })
      .rpc();
  } catch (e: any) {
    // 如果白名单已存在，跳过初始化
    if (e.toString().includes('already in use') || e.toString().includes('ConstraintSpace')) {
      console.log('White list already initialized, skipping...');
    } else {
      throw e;
    }
  }

  const whitelistTokenAccounts = [];
  const ownersToWhitelist = [payer.publicKey, ...whitelistOwners];

  for (const owner of ownersToWhitelist) {
    const instructions: any[] = [];
    const tokenAccount = await ensureAssociatedTokenAccount(
      connection,
      payer,
      owner,
      mint.publicKey,
      instructions,
    );

    if (instructions.length > 0) {
      await provider.sendAndConfirm(new Transaction().add(...instructions));
    }

    await program.methods
      .addToWhitelist()
      .accounts({
        newAccount: tokenAccount,
        signer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    whitelistTokenAccounts.push({
      owner: owner.toBase58(),
      tokenAccount: tokenAccount.toBase58(),
    });
  }

  const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
    [Buffer.from('extra-account-metas'), mint.publicKey.toBuffer()],
    program.programId,
  );

  const [whiteList] = PublicKey.findProgramAddressSync(
    [Buffer.from('white_list')],
    program.programId,
  );

  return {
    name: tokenConfig.name,
    symbol: tokenConfig.symbol,
    decimals: tokenConfig.decimals,
    initialSupplyUi: tokenConfig.initialSupplyUi,
    mint: mint.publicKey.toBase58(),
    treasuryTokenAccount: treasuryAta.toBase58(),
    extraAccountMetaList: extraAccountMetaList.toBase58(),
    whiteList: whiteList.toBase58(),
    whitelistTokenAccounts,
  };
}

function writeDeploymentManifest(clusterName: string, programId: string, deployedTokens: any[]) {
  const outputDir = path.join(process.cwd(), 'deployments');
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
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
      2,
    ),
  );

  return outputPath;
}

async function main() {
  const connection = new anchor.web3.Connection(
    "https://devnet.helius-rpc.com/?api-key=7c8a6828-2b0b-456b-a1fc-f08073e8304a",
    anchor.AnchorProvider.defaultOptions().commitment
  );
  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet);

  console.log('=== Migration script started ===');
  anchor.setProvider(provider);

  const program = anchor.workspace.TransferHook;
  const clusterName = provider.connection.rpcEndpoint;
  const whitelistOwners = parseWhitelistOwners();

  console.log('Transfer hook program:', program.programId.toBase58());
  console.log('Deployer:', provider.wallet.publicKey.toBase58());
  console.log(
    'Whitelist owners:',
    whitelistOwners.length > 0
      ? whitelistOwners.map((owner) => owner.toBase58()).join(', ')
      : '(deployer treasury ATA only)',
  );

  const deployedTokens = [];
  for (const tokenConfig of TOKEN_CONFIGS) {
    const token = await createTransferHookMint(provider, program, tokenConfig, whitelistOwners);
    deployedTokens.push(token);

    console.log(`[${token.symbol}] mint: ${token.mint}`);
    console.log(`[${token.symbol}] treasury ATA: ${token.treasuryTokenAccount}`);
    console.log(`[${token.symbol}] extra account meta list: ${token.extraAccountMetaList}`);
  }

  const manifestPath = writeDeploymentManifest(
    clusterName.replace(/[^a-zA-Z0-9_-]/g, '_'),
    program.programId.toBase58(),
    deployedTokens,
  );

  console.log('Deployment manifest written to:', manifestPath);
  console.log(
    'Note: this program uses a single shared white_list PDA for every mint in this deployment.',
  );
}

main();
