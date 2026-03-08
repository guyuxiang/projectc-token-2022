import type { Program } from '@coral-xyz/anchor';
import * as anchor from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair, SystemProgram, sendAndConfirmTransaction, Transaction, PublicKey } from '@solana/web3.js';
import type { TransferHook } from '../target/types/transfer_hook';

describe('transfer-hook-whitelist-test', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TransferHook as Program<TransferHook>;
  const wallet = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  // ============ 配置项 ============
  // GLUSD Mint 地址 (测试网)
  const GLUSD_MINT = new PublicKey('GlUsD1L2V9GqjdPCJ8q股票3kQ5M8tY2'); // TODO: 替换为实际的 GLUSD Mint 地址
  const decimals = 9;

  // 用户 A (发送方) - 使用当前钱包
  const userA = wallet.publicKey;

  // 用户 B (接收方) - 生成一个新密钥对
  const userB = Keypair.generate();

  // 用户 A 的代币账户
  const userATokenAccount = getAssociatedTokenAddressSync(
    GLUSD_MINT,
    userA,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // 用户 B 的代币账户
  const userBTokenAccount = getAssociatedTokenAddressSync(
    GLUSD_MINT,
    userB.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  it('1. 为用户 B 创建代币账户', async () => {
    const transaction = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        userBTokenAccount,
        userB.publicKey,
        GLUSD_MINT,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );

    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });
    console.log(`创建用户 B 代币账户: ${txSig}`);
    console.log(`用户 B 地址: ${userB.publicKey.toBase58()}`);
    console.log(`用户 B 代币账户: ${userBTokenAccount.toBase58()}`);
  });

  it('2. 初始化 ExtraAccountMetaList (设置白名单功能)', async () => {
    const initializeExtraAccountMetaListInstruction = await program.methods
      .initializeExtraAccountMetaList()
      .accounts({
        mint: GLUSD_MINT,
      })
      .instruction();

    const transaction = new Transaction().add(initializeExtraAccountMetaListInstruction);
    const txSig = await sendAndConfirmTransaction(provider.connection, transaction, [wallet.payer], { skipPreflight: true, commitment: 'confirmed' });

    console.log(`初始化 ExtraAccountMetaList: ${txSig}`);
  });

  it('3. 将用户 A 添加到白名单', async () => {
    const addAccountToWhiteListInstruction = await program.methods
      .addToWhitelist()
      .accounts({
        newAccount: userATokenAccount,
        signer: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const transaction = new Transaction().add(addAccountToWhiteListInstruction);
    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });

    console.log(`用户 A 添加到白名单: ${txSig}`);
    console.log(`用户 A 代币账户: ${userATokenAccount.toBase58()}`);
  });

  it('4. 将用户 B 添加到白名单', async () => {
    const addAccountToWhiteListInstruction = await program.methods
      .addToWhitelist()
      .accounts({
        newAccount: userBTokenAccount,
        signer: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const transaction = new Transaction().add(addAccountToWhiteListInstruction);
    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });

    console.log(`用户 B 添加到白名单: ${txSig}`);
  });

  it('5. 发行 1000 GLUSD 给用户 A (Mint To)', async () => {
    const amount = 1000 * 10 ** decimals;

    const transaction = new Transaction().add(
      createMintToInstruction(
        GLUSD_MINT,
        userATokenAccount,
        wallet.publicKey,
        amount,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    );

    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });
    console.log(`发行 1000 GLUSD 给用户 A: ${txSig}`);
  });

  it('6. 用户 A 转账 500 GLUSD 给用户 B', async () => {
    const amount = 500 * 10 ** decimals;
    const bigIntAmount = BigInt(amount);

    const transferInstruction = await createTransferCheckedWithTransferHookInstruction(
      connection,
      userATokenAccount,
      GLUSD_MINT,
      userBTokenAccount,
      wallet.publicKey,
      bigIntAmount,
      decimals,
      [],
      'confirmed',
      TOKEN_2022_PROGRAM_ID,
    );

    const transaction = new Transaction().add(transferInstruction);
    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });

    console.log(`用户 A 转账 500 GLUSD 给用户 B: ${txSig}`);
  });

  it('7. 验证余额', async () => {
    const userABalance = await connection.getTokenAccountBalance(userATokenAccount, 'confirmed');
    const userBBalance = await connection.getTokenAccountBalance(userBTokenAccount, 'confirmed');

    console.log(`用户 A 余额: ${userABalance.value.uiAmountString} GLUSD`);
    console.log(`用户 B 余额: ${userBBalance.value.uiAmountString} GLUSD`);
  });
});